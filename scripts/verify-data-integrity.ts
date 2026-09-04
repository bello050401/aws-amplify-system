/**
 * 実データの整合性監査（2026-09-04 健全化 PHASE 3 → 最終フェーズ Phase B）。
 *
 *   AWS_PROFILE=Bello npm run verify:data-integrity            … 数えて表示する
 *   AWS_PROFILE=Bello npm run verify:data-integrity -- --diff  … 前回の基準値と比べる
 *   AWS_PROFILE=Bello npm run verify:data-integrity -- --diff --save
 *                                                              … 比べて、基準値と履歴を保存する
 *
 * ── 何のためか ──────────────────────────────────────────────────
 *
 * テストが通ることと、実データが壊れていないことは別。ここでは実際の
 * テーブルを**読むだけ**で、孤児・重複・欠落・途中状態を数える。
 * **修復は一切しない** —— 何をどう直すかは業務判断なので、
 * 「何件、どれが」を出すところまでにとどめる。
 *
 * ── 数え方と判定はLambdaと共有する ──────────────────────────────
 *
 * 数え方は lib/integrity/collect.ts、前回との比較は
 * lib/integrity/compare.ts。日次実行のLambda
 * （amplify/functions/integrity-monitor）と**同じコードを通る**。
 * 2箇所に書くと、片方だけ直った日に「監視は正常なのに手元では異常」
 * という一番たちの悪いずれ方をする。
 *
 * ── 絶対件数では判定しない ──────────────────────────────────────
 *
 * 実データには「消してはいけない残骸」がある（2026-08-30のZAICO重複作成
 * 事故で消された在庫の履歴315件分など。古物台帳として残すべきもの）。
 * 見たいのは「315のままか」「316に増えたか」なので、`--diff` は
 * 前回の基準値との差だけを見る。
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { collectIntegrityMetrics } from "@/lib/integrity/collect";
import { compareIntegrity, formatRunResult, toHistoryEntry } from "@/lib/integrity/compare";
import { appendHistory, loadBaseline, saveBaseline } from "@/lib/integrity/store";
import { ensureConversationTableName } from "./lib/resolveStagingTables";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

const args = process.argv.slice(2);
const WANT_DIFF = args.includes("--diff");
const WANT_SAVE = args.includes("--save");

/**
 * 監視ログのテーブル名を、**日次Lambda自身の設定から**取る。
 *
 * このテーブルは生CDK製で `<Model>-<apiId>-<env>` の形をしておらず、
 * さらに backend.ts が全アプリ共有なので**本番とStagingの2つ存在する**。
 * 名前の部分一致で選ぶと、手元の実行とスケジュール実行が別の基準値を
 * 見る事故になる（そうなると差分判定そのものが意味を失う）。
 *
 * Lambda の環境変数を読めば「スケジュール実行が実際に使っているテーブル」
 * が一意に決まる。同じ store を共有していることが保証される。
 */
async function findIntegrityLogTable(): Promise<string | null> {
  const { LambdaClient, ListFunctionsCommand, GetFunctionConfigurationCommand } = await import("@aws-sdk/client-lambda");
  const lambda = new LambdaClient({ region: REGION });
  const appId = process.env.BELLO_AMPLIFY_APP_ID ?? "d4hkkg7dty2du"; // Staging
  let marker: string | undefined;
  do {
    const res = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
    for (const fn of res.Functions ?? []) {
      const name = fn.FunctionName ?? "";
      if (!name.includes("integritymonitor") || !name.includes(appId)) continue;
      const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      const table = cfg.Environment?.Variables?.INTEGRITY_LOG_TABLE_NAME;
      if (table) return table;
    }
    marker = res.NextMarker;
  } while (marker);

  // Lambda が見つからない環境（デプロイ前など）では、テーブル名の一致で
  // 一意に決まる場合だけ受け入れる。複数あるなら諦める（取り違えない）。
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  const hits = names.filter((n) => n.includes("IntegrityCheckLog") && n.includes(appId));
  return hits.length === 1 ? hits[0] : null;
}

async function main() {
  await ensureConversationTableName();
  const { directTableName } = await import("@/lib/amplify/directData");
  console.log(`[verify-data-integrity] ${directTableName("Inventory")} ほか\n`);

  const { metrics, details } = await collectIntegrityMetrics({ ddb, tableFor: directTableName });
  const detailByKey = new Map(details.map((d) => [d.key, d.examples]));

  // ── 数えた結果をそのまま出す ────────────────────────────────
  let errors = 0;
  let nonZero = 0;
  const width = Math.max(...metrics.map((m) => m.label.length));
  for (const m of metrics) {
    if (m.value === null) {
      errors++;
      console.error(`! ${m.label.padEnd(width)}  取得できませんでした（${m.error ?? "理由不明"}）`);
      continue;
    }
    const mark = m.value === 0 ? "✓" : "・";
    if (m.value > 0) nonZero++;
    console.log(`${mark} ${m.label.padEnd(width)}  ${m.value}件`);
    for (const ex of (detailByKey.get(m.key) ?? []).slice(0, 3)) console.log(`      ${ex}`);
  }
  console.log(`\n検査 ${metrics.length}項目 / 0件でない項目 ${nonZero} / 取得できず ${errors}`);

  if (!WANT_DIFF) {
    console.log("\n（前回との差を見るには --diff、基準値を更新するには --diff --save）");
    process.exit(0);
  }

  // ── 前回の基準値と比べる ────────────────────────────────────
  const tableName = await findIntegrityLogTable();
  if (!tableName) {
    console.error("\n監視ログのテーブルが見つかりません（IntegrityCheckLog）。");
    console.error("バックエンドのデプロイが済んでいない可能性があります。差分判定は行いませんでした。");
    process.exit(1);
  }
  const store = { ddb, tableName };
  const runAt = new Date().toISOString();
  const baseline = await loadBaseline(store);
  const result = compareIntegrity(metrics, baseline, runAt);

  console.log(`\n■ 前回との差（基準値: ${baseline ? baseline.updatedAt : "まだ無い"}）\n`);
  console.log(formatRunResult(result));

  if (WANT_SAVE) {
    await appendHistory(store, toHistoryEntry(result));
    await saveBaseline(store, result.nextBaseline);
    console.log(`\n基準値と履歴を ${tableName} へ保存しました。`);
  } else {
    console.log("\n（保存するには --save を付けてください）");
  }

  // 新しい異常があったときだけ異常終了する。既知の残骸では落とさない。
  process.exit(result.overall === "FAIL" || result.overall === "ERROR" ? 1 : 0);
}

void main().catch((err) => {
  console.error(`[verify-data-integrity] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

/**
 * 夜間統合指示書(2026-09-01) §5.1: AI商品説明の品質評価。
 * **実際のNovaモデルを呼ぶ**(他のverify:*と違い、料金と時間がかかる)。
 *
 * Run with: AWS_PROFILE=Bello npm run evaluate:listing-copy [件数]
 *
 * ## 何を測るか
 *
 * 本番Inventoryから実在の商品を取り、同じ商品について2通りの渡し方で
 * 生成して比較する。
 *
 *   - BEFORE: 2026-09-01以前の渡し方。`conditionRating`(社内の5段階
 *     スコア)と`note`(顧客の住所が混ざり得る)をそのまま渡す。
 *   - AFTER : buildCustomerSafeFacts を通した渡し方。社内スコアを落とし、
 *     顧客向けの状態説明(damageNotes)を渡す。
 *
 * どちらも **品質ゲートを通す前の生の生成結果** を
 * checkFactSafety で採点する。ゲート後だけを見てもゲートの効果は
 * 分からないため、意図的に生の結果を測っている。
 *
 * ## 出すもの
 *
 * 違反の種類別件数・違反した商品の割合・レイテンシ・文字数。
 * **商品説明の全文は出さない**(長すぎるため。代表例だけ先頭を出す)。
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { generateListingCopyOnce, type ListingCopyResult } from "@/lib/ai/ecCopy";
import { buildCustomerSafeFacts } from "@/lib/ai/productIntro/facts";
import { checkFactSafety, type FactSafetyViolationCode } from "@/lib/ai/productIntro/factSafety";
import { buildStyleExamplesForProduct } from "@/lib/ai/productIntro/styleCorpusLoader";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

interface InventoryRow {
  id: string;
  sku?: string;
  name?: string;
  quantity?: number;
  width?: string;
  depth?: string;
  height?: string;
  conditionRating?: string;
  damageNotes?: string;
  note?: string;
  deletedAt?: string;
}

async function resolveInventoryTable(): Promise<string> {
  if (process.env.BELLO_INVENTORY_TABLE) return process.env.BELLO_INVENTORY_TABLE;
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  // verify-zaico-reconciliation.ts と同じ考え方: 必要なモデルが揃っている
  // apiId を選ぶ(過去の残骸アプリのテーブルと取り違えないため)。
  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()].filter(([, s]) => s.has("Inventory") && s.has("ZaicoSourceLink")).map(([a]) => a);
  if (complete.length !== 1) throw new Error(`Inventoryテーブルを一意に決められません(候補${complete.length}件)。BELLO_INVENTORY_TABLEで明示してください。`);
  return names.find((n) => n.startsWith(`Inventory-${complete[0]}-`))!;
}

async function sampleInventory(table: string, wanted: number): Promise<InventoryRow[]> {
  const out: InventoryRow[] = [];
  let key: Record<string, unknown> | undefined;
  // 全件スキャンはしない。必要な件数が集まった時点で止める。
  for (let page = 0; page < 20 && out.length < wanted * 4; page++) {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        // `name` と `depth` はDynamoDBの予約語なので別名で参照する。
        ProjectionExpression: "id, sku, #n, quantity, width, #d, height, conditionRating, damageNotes, note, deletedAt",
        ExpressionAttributeNames: { "#n": "name", "#d": "depth" },
        ExclusiveStartKey: key,
        Limit: 200,
      }),
    );
    out.push(...((res.Items ?? []) as InventoryRow[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!key) break;
  }
  // 生きている、名前のある商品だけ。conditionRatingが入っているものを優先
  // (社内スコアの露出を測るのが主目的のため)。
  const usable = out.filter((r) => !r.deletedAt && (r.name ?? "").trim().length > 0);
  const withRating = usable.filter((r) => (r.conditionRating ?? "").trim());
  const without = usable.filter((r) => !(r.conditionRating ?? "").trim());
  return [...withRating, ...without].slice(0, wanted);
}

interface Outcome {
  violations: FactSafetyViolationCode[];
  ms: number;
  descriptionLength: number;
  error?: string;
  sample?: ListingCopyResult;
}

async function runOne(mode: "BEFORE" | "AFTER", row: InventoryRow): Promise<Outcome> {
  const started = Date.now();
  const name = (row.name ?? "").trim();

  const { facts } = buildCustomerSafeFacts({
    name,
    width: row.width,
    depth: row.depth,
    height: row.height,
    conditionRating: row.conditionRating,
    damageNotes: row.damageNotes,
    note: row.note,
  });

  // 採点の基準となる「認めてよい事実」は、どちらのモードでも同じ
  // (=顧客向けに出してよい事実)。BEFOREはそこへ社内スコア等を
  // 追加で渡してしまっている、という差だけを見る。
  const dims = [row.width, row.depth, row.height].filter((v) => (v ?? "").trim()).length
    ? `幅${row.width ?? "-"} × 奥行${row.depth ?? "-"} × 高さ${row.height ?? "-"} (cm)`
    : null;

  const input =
    mode === "BEFORE"
      ? { name, dimensions: dims, conditionNote: row.conditionRating ?? null, note: row.note ?? null }
      : {
          name: facts.name,
          dimensions: facts.dimensions,
          categoryName: facts.categoryName,
          conditionNote: facts.conditionDisclosure,
          note: facts.publicNote,
          // 本番経路(generateListingCopy)と同じ文体例を添える。
          styleExamplesBlock: buildStyleExamplesForProduct(facts.name),
        };

  try {
    const result = await generateListingCopyOnce(input);
    const checked = checkFactSafety({
      output: [result.description, result.conditionText, ...(result.sellingPoints ?? [])].join("\n"),
      facts,
      stockQuantity: row.quantity ?? null,
      sku: row.sku ?? null,
      maxLength: 2500,
    });
    return {
      violations: checked.violations.map((v) => v.code),
      ms: Date.now() - started,
      descriptionLength: result.description.length,
      sample: result,
    };
  } catch (err) {
    return { violations: [], ms: Date.now() - started, descriptionLength: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function summarize(label: string, outcomes: Outcome[]) {
  const ok = outcomes.filter((o) => !o.error);
  const failed = outcomes.filter((o) => o.error);
  const clean = ok.filter((o) => o.violations.length === 0);
  const counts = new Map<string, number>();
  for (const o of ok) for (const v of new Set(o.violations)) counts.set(v, (counts.get(v) ?? 0) + 1);
  const avgMs = ok.length ? Math.round(ok.reduce((s, o) => s + o.ms, 0) / ok.length) : 0;
  const avgLen = ok.length ? Math.round(ok.reduce((s, o) => s + o.descriptionLength, 0) / ok.length) : 0;

  console.log(`\n── ${label} ──────────────────────────────────`);
  console.log(`  生成成功           : ${ok.length}/${outcomes.length}${failed.length ? ` (失敗 ${failed.length})` : ""}`);
  console.log(`  違反なし(合格)     : ${clean.length}/${ok.length}${ok.length ? ` (${Math.round((clean.length / ok.length) * 100)}%)` : ""}`);
  console.log(`  平均レイテンシ     : ${avgMs}ms`);
  console.log(`  説明文の平均文字数 : ${avgLen}`);
  if (counts.size > 0) {
    console.log("  違反の内訳(商品数):");
    [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
  }
  for (const o of failed.slice(0, 3)) console.log(`  [生成失敗] ${o.error}`);
  return { clean: clean.length, total: ok.length, counts };
}

async function main() {
  const wanted = Number(process.argv[2] ?? 20);
  const table = await resolveInventoryTable();
  console.log(`inventory=${table}`);
  const rows = await sampleInventory(table, wanted);
  console.log(`評価対象: ${rows.length}件（うちconditionRating設定済み ${rows.filter((r) => (r.conditionRating ?? "").trim()).length}件）\n`);

  const before: Outcome[] = [];
  const after: Outcome[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stdout.write(`\r  生成中 ${i + 1}/${rows.length} …`);
    before.push(await runOne("BEFORE", row));
    after.push(await runOne("AFTER", row));
  }
  process.stdout.write("\r".padEnd(40) + "\r");

  const b = summarize("BEFORE（2026-09-01以前の渡し方: 社内スコア・noteをそのまま渡す）", before);
  const a = summarize("AFTER（buildCustomerSafeFactsを通した渡し方）", after);

  console.log("\n── 比較 ──────────────────────────────────────");
  const bRate = b.total ? Math.round((b.clean / b.total) * 100) : 0;
  const aRate = a.total ? Math.round((a.clean / a.total) * 100) : 0;
  console.log(`  違反なしの割合: ${bRate}% → ${aRate}%`);
  for (const code of new Set([...b.counts.keys(), ...a.counts.keys()])) {
    console.log(`  ${code}: ${b.counts.get(code) ?? 0}件 → ${a.counts.get(code) ?? 0}件`);
  }

  // 代表例(先頭のみ)。全文は出さない。
  const example = after.find((o) => o.sample && o.violations.length === 0)?.sample;
  if (example) {
    console.log("\n── AFTERの生成例(先頭のみ) ───────────────────");
    console.log(`  title      : ${example.title}`);
    console.log(`  description: ${example.description.slice(0, 200)}${example.description.length > 200 ? "…" : ""}`);
    console.log(`  condition  : ${example.conditionText.slice(0, 120)}`);
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

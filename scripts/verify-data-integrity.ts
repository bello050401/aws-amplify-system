/**
 * 実データの整合性監査（2026-09-04 健全化 PHASE 3）。
 *
 *   AWS_PROFILE=Bello npm run verify:data-integrity
 *
 * ── 何のためか ──────────────────────────────────────────────────
 *
 * テストが通ることと、実データが壊れていないことは別。ここでは実際の
 * テーブルを**読むだけ**で、次の3種類を探す。
 *
 *   孤児   … 存在しない行を指している参照（例: 削除済み在庫を指す履歴）
 *   重複   … 一意であるはずのキーが2件以上（例: 同じZAICO在庫IDの在庫）
 *   欠落   … 動作に必要な値が入っていない（例: listingPartition の無い在庫）
 *
 * とくに、直したばかりの2つの不具合が**既に実害を出していないか**を
 * ここで確かめる:
 *
 *   ・ZAICO重複統合が参照の付け替えに失敗したまま在庫を消した
 *     → 存在しない inventoryId を指す履歴・出品・会話が残る
 *   ・通知の重複防止をすり抜けて2件作られた
 *     → 同じ dedupeKey の NotificationDelivery が2件以上
 *
 * ── 読み取り専用 ────────────────────────────────────────────────
 *
 * Scan しかしない。修復は一切しない —— 何をどう直すかは業務判断なので、
 * ここでは「何件、どれが」を出すところまでにとどめる。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ensureConversationTableName } from "./lib/resolveStagingTables";

const REGION = process.env.AWS_REGION || "us-west-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
/** 並列Scanのセグメント数（lib/inventory/inventorySearchFast.ts と同じ理由）。 */
const SEGMENTS = 8;

let findings = 0;
let checks = 0;

function ok(label: string, detail = "") {
  checks++;
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}
function issue(label: string, count: number, examples: string[]) {
  checks++;
  findings++;
  console.error(`✗ ${label} — ${count}件`);
  for (const e of examples.slice(0, 5)) console.error(`    ${e}`);
  if (examples.length > 5) console.error(`    …ほか ${examples.length - 5} 件`);
}

/** 属性を絞った並列Scan。全件を一度だけ読む。 */
async function scanAll(table: string, attrs: string[]): Promise<Record<string, unknown>[]> {
  const names: Record<string, string> = {};
  const proj = attrs.map((a, i) => {
    names[`#a${i}`] = a;
    return `#a${i}`;
  });
  const segment = async (seg: number) => {
    const out: Record<string, unknown>[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new ScanCommand({
          TableName: table,
          Segment: seg,
          TotalSegments: SEGMENTS,
          ProjectionExpression: proj.join(", "),
          ExpressionAttributeNames: names,
          ExclusiveStartKey: key,
        }),
      );
      out.push(...((res.Items ?? []) as Record<string, unknown>[]));
      key = res.LastEvaluatedKey;
    } while (key);
    return out;
  };
  const parts = await Promise.all(Array.from({ length: SEGMENTS }, (_, i) => segment(i)));
  return parts.flat();
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** 参照先が存在しない行を探す。 */
function findOrphans(
  rows: Record<string, unknown>[],
  refField: string,
  known: Set<string>,
): { count: number; examples: string[] } {
  const bad: string[] = [];
  for (const r of rows) {
    const ref = str(r[refField]);
    if (ref && !known.has(ref)) bad.push(`id=${String(r.id)} ${refField}=${ref}`);
  }
  return { count: bad.length, examples: bad };
}

/** 一意であるはずの値が2件以上ある行を探す。 */
function findDuplicates(rows: Record<string, unknown>[], field: string): { count: number; examples: string[] } {
  const byValue = new Map<string, string[]>();
  for (const r of rows) {
    const v = str(r[field]);
    if (!v) continue;
    const list = byValue.get(v);
    if (list) list.push(String(r.id));
    else byValue.set(v, [String(r.id)]);
  }
  const dups = [...byValue.entries()].filter(([, ids]) => ids.length > 1);
  return { count: dups.length, examples: dups.map(([v, ids]) => `${field}=${v} → ${ids.length}件 (${ids.slice(0, 3).join(", ")})`) };
}

function report(label: string, r: { count: number; examples: string[] }, zeroMessage: string) {
  if (r.count === 0) ok(label, zeroMessage);
  else issue(label, r.count, r.examples);
}

/**
 * 既に分かっている残骸の件数を基準にして、**増えていないこと**を見る。
 *
 * 0件にできない（＝消すと監査履歴が失われる、あるいは業務判断が要る）
 * ものを毎回「異常」と出し続けると、そのうち誰も読まなくなる。
 * 基準値を書いておき、そこから増えたときだけ落とす。
 */
function baselineReport(label: string, actual: number, baseline: number, examples: string[]) {
  checks++;
  if (actual <= baseline) {
    console.log(`✓ ${label} — ${actual}件（既知の残骸 ${baseline}件以下）`);
    return;
  }
  findings++;
  console.error(`✗ ${label} — ${actual}件（既知は ${baseline}件。${actual - baseline}件増えている）`);
  for (const e of examples.slice(0, 5)) console.error(`    ${e}`);
}

/**
 * 2026-09-04 時点で分かっている残骸の件数。
 *
 * ── 在庫履歴 315件分 ──
 * 全328行のうち314行が「ZAICO同期 / ZAICO ID xxx から新規作成」で、
 * **すべて2026-08-30**。この日はZAICO同期が同じ商品を重複作成していた
 * 不具合の日で（lib/inventory/zaicoDuplicateAudit.ts 冒頭の経緯参照）、
 * その後の重複整理で消された在庫の履歴がこれ。在庫を消しても履歴は残す
 * 設計なので、**消すべきではない**（古物台帳としての記録）。
 *
 * ── 通知 6件 ──
 * scripts/cleanup-mercari-misingested.ts が誤取込の会話を消したときの
 * 取りこぼし。同スクリプトは Message / ReplyDraft / NotificationDelivery を
 * `.list({limit: 900})` の**1ページだけ**で拾っており、収まらなかったぶんが
 * 残っている。表示上は「会話へ辿れない通知」になるだけで、送信済みの
 * 記録としては正しい。
 *
 * ── 出品下書き 1件 ──
 * 在庫を削除しても ListingDraft は消さないため。
 *
 * いずれも増えていないことだけを見る。増えたら新しい事故。
 */
const KNOWN_ORPHANED_HISTORY_INVENTORIES = 315;
const KNOWN_ORPHANED_DELIVERIES = 6;
const KNOWN_ORPHANED_LISTING_DRAFTS = 1;

async function main() {
  await ensureConversationTableName();
  const { directTableName } = await import("@/lib/amplify/directData");
  const t = (m: string) => directTableName(m);
  console.log(`[verify-data-integrity] ${t("Inventory")} ほか\n`);

  // ── 在庫本体 ──────────────────────────────────────────────────
  const inventory = await scanAll(t("Inventory"), [
    "id",
    "sku",
    "name",
    "sourceSystem",
    "sourceInventoryId",
    "categoryId",
    "locationId",
    "statusId",
    "listingPartition",
    "deletedAt",
  ]);
  const live = inventory.filter((r) => !str(r.deletedAt));
  const liveIds = new Set(live.map((r) => String(r.id)));
  console.log(`■ 在庫 ${inventory.length}件（うち生存 ${live.length}件）`);

  const missingPartition = live.filter((r) => !str(r.listingPartition));
  report(
    "在庫: listingPartition が入っている（無いと一覧のGSIに載らず、画面に出てこない）",
    { count: missingPartition.length, examples: missingPartition.map((r) => `id=${String(r.id)} sku=${String(r.sku)}`) },
    `${live.length}件すべて設定済み`,
  );

  const missingSku = live.filter((r) => !str(r.sku) || !str(r.name));
  report(
    "在庫: SKUと商品名が入っている",
    { count: missingSku.length, examples: missingSku.map((r) => `id=${String(r.id)}`) },
    "欠落なし",
  );

  report("在庫: SKUが重複していない", findDuplicates(live, "sku"), "重複なし");

  const zaicoLinked = live.filter((r) => str(r.sourceSystem) === "ZAICO" && str(r.sourceInventoryId));
  report(
    "在庫: 同じZAICO在庫IDの行が2件以上ない（重複同期）",
    findDuplicates(zaicoLinked, "sourceInventoryId"),
    `ZAICO連携 ${zaicoLinked.length}件で重複なし`,
  );

  // ── マスタ参照 ────────────────────────────────────────────────
  const categories = new Set((await scanAll(t("Category"), ["id"])).map((r) => String(r.id)));
  const locations = new Set((await scanAll(t("Location"), ["id"])).map((r) => String(r.id)));
  const statuses = new Set((await scanAll(t("StatusMaster"), ["id"])).map((r) => String(r.id)));
  console.log(`\n■ マスタ カテゴリ${categories.size} / 保管場所${locations.size} / 状態${statuses.size}`);
  report("在庫: categoryId が実在するカテゴリを指している", findOrphans(live, "categoryId", categories), "孤児なし");
  report("在庫: locationId が実在する保管場所を指している", findOrphans(live, "locationId", locations), "孤児なし");
  report("在庫: statusId が実在する状態を指している", findOrphans(live, "statusId", statuses), "孤児なし");

  // ── 在庫を指す関連レコード（重複統合の失敗で孤児になりうる先） ──
  console.log("\n■ 在庫を参照している関連レコード");
  // 在庫履歴だけは別扱い。**在庫を削除しても履歴は残す設計**
  // (app/actions/inventory.ts の deleteInventory は物理削除のあとに
  //  「削除」の履歴を書く —— 古物台帳として消えては困るため)。
  // したがって「存在しない在庫を指す履歴」は正常な状態でも必ず出る。
  // 問題なのは**削除の記録が無いのに在庫だけ消えている**もので、それは
  // 重複統合の付け替え失敗のような事故の跡になる。両者を分けて数える。
  {
    const history = await scanAll(t("InventoryHistory"), ["id", "inventoryId", "fieldName"]);
    const orphanIds = new Set<string>();
    const deletedIds = new Set<string>();
    for (const r of history) {
      const ref = str(r.inventoryId);
      if (!ref) continue;
      if (str(r.fieldName) === "削除") deletedIds.add(ref);
      if (!liveIds.has(ref)) orphanIds.add(ref);
    }
    const expected = [...orphanIds].filter((id) => deletedIds.has(id));
    const unexplained = [...orphanIds].filter((id) => !deletedIds.has(id));
    console.log(`  在庫履歴 ${history.length}件 / 存在しない在庫を指すもの ${orphanIds.size}件分の在庫`);
    ok("在庫履歴: 削除済み在庫の履歴が残っている（設計どおり）", `${expected.length}件の在庫ぶん`);
    // 内訳を出す。「何件あるか」より「どういう履歴が残っているか」のほうが
    // 原因の切り分けに効く。
    const fieldCounts = new Map<string, number>();
    for (const r of history) {
      const ref = str(r.inventoryId);
      if (!ref || liveIds.has(ref)) continue;
      const f = str(r.fieldName) ?? "(なし)";
      fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1);
    }
    const breakdown = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f}:${c}`).join(" / ");
    console.log(`  内訳 ${breakdown}`);
    baselineReport(
      "在庫履歴: 削除の記録が無い孤児が既知の残骸より増えていない",
      unexplained.length,
      KNOWN_ORPHANED_HISTORY_INVENTORIES,
      unexplained.map((id) => `inventoryId=${id}`),
    );
  }

  {
    const drafts = await scanAll(t("ListingDraft"), ["id", "inventoryId"]);
    const orphans = findOrphans(drafts, "inventoryId", liveIds);
    baselineReport(
      `出品下書き: 存在しない在庫を指す行が増えていない（${drafts.length}件中）`,
      orphans.count,
      KNOWN_ORPHANED_LISTING_DRAFTS,
      orphans.examples,
    );
  }

  const related: { model: string; field: string; label: string }[] = [
    { model: "ChannelListing", field: "inventoryId", label: "チャネル出品" },
    { model: "ProcessingJob", field: "inventoryId", label: "画像処理ジョブ" },
    { model: "ImageProcessingVersion", field: "inventoryId", label: "画像処理履歴" },
    { model: "ZaicoSourceLink", field: "inventoryId", label: "ZAICO連携リンク" },
    { model: "MercariOrderContext", field: "inventoryId", label: "メルカリ注文コンテキスト" },
  ];
  for (const { model, field, label } of related) {
    let rows: Record<string, unknown>[];
    try {
      rows = await scanAll(t(model), ["id", field]);
    } catch (err) {
      console.warn(`  （${label}: 読み取れませんでした — ${err instanceof Error ? err.name : "unknown"}）`);
      continue;
    }
    report(
      `${label}: 存在しない在庫を指していない（${rows.length}件中）`,
      findOrphans(rows, field, liveIds),
      "孤児なし",
    );
  }

  // ── 会話とメッセージ ──────────────────────────────────────────
  console.log("\n■ 会話・メッセージ・通知");
  const conversations = await scanAll(t("Conversation"), ["id", "relatedInventoryId"]);
  const conversationIds = new Set(conversations.map((r) => String(r.id)));
  report(
    `会話: relatedInventoryId が存在しない在庫を指していない（${conversations.length}件中）`,
    findOrphans(conversations, "relatedInventoryId", liveIds),
    "孤児なし",
  );

  const messages = await scanAll(t("Message"), ["id", "conversationId", "externalMessageId"]);
  report(
    `メッセージ: 存在しない会話を指していない（${messages.length}件中）`,
    findOrphans(messages, "conversationId", conversationIds),
    "孤児なし",
  );
  report(
    "メッセージ: 同じexternalMessageIdが2件以上ない（受信の二重登録）",
    findDuplicates(messages, "externalMessageId"),
    "重複なし",
  );

  const deliveries = await scanAll(t("NotificationDelivery"), ["id", "dedupeKey", "conversationId", "status"]);
  report(
    "通知: 同じdedupeKeyが2件以上ない（LINEへの二重送信）",
    findDuplicates(deliveries, "dedupeKey"),
    `${deliveries.length}件で重複なし`,
  );
  {
    const orphans = findOrphans(deliveries, "conversationId", conversationIds);
    baselineReport(
      `通知: 存在しない会話を指す行が増えていない（${deliveries.length}件中）`,
      orphans.count,
      KNOWN_ORPHANED_DELIVERIES,
      orphans.examples,
    );
  }

  // ── 途中状態で止まっているもの ────────────────────────────────
  //
  // 「開始したが終わっていない」行は、プロセスが途中で落ちた跡。放置すると
  // 次の処理が「別の処理が進行中」と判断して永久に進まなくなることがある。
  // ただし**今まさに走っている最中**の行も同じ見た目なので、時間で切る。
  console.log("\n■ 途中状態で止まっている行");
  const STUCK_AFTER_MS = 60 * 60 * 1000; // 1時間。どの処理も通常は数分で終わる。
  const now = Date.now();
  const isStale = (v: unknown) => {
    const t = Date.parse(str(v) ?? "");
    return Number.isFinite(t) && now - t > STUCK_AFTER_MS;
  };

  const stuckDeliveries = deliveries.filter((r) => str(r.status) === "PROCESSING");
  report(
    "通知: PROCESSING のまま残っている行がない（送信中にプロセスが落ちた跡）",
    { count: stuckDeliveries.length, examples: stuckDeliveries.map((r) => `id=${String(r.id)}`) },
    "なし",
  );

  const stuckChecks: { model: string; label: string; statuses: string[]; timeField: string }[] = [
    { model: "ZaicoSyncJob", label: "ZAICO同期ジョブ", statuses: ["RUNNING"], timeField: "updatedAt" },
    { model: "ProcessingJob", label: "画像処理ジョブ", statuses: ["PROCESSING"], timeField: "updatedAt" },
    { model: "ListingDraft", label: "出品下書き", statuses: ["PUBLISHING", "QUEUED"], timeField: "updatedAt" },
  ];
  for (const { model, label, statuses, timeField } of stuckChecks) {
    let rows: Record<string, unknown>[];
    try {
      rows = await scanAll(t(model), ["id", "status", timeField]);
    } catch (err) {
      console.warn(`  （${label}: 読み取れませんでした — ${err instanceof Error ? err.name : "unknown"}）`);
      continue;
    }
    const stuck = rows.filter((r) => statuses.includes(str(r.status) ?? "") && isStale(r[timeField]));
    report(
      `${label}: ${statuses.join("/")} のまま1時間以上動いていない行がない（${rows.length}件中）`,
      { count: stuck.length, examples: stuck.map((r) => `id=${String(r.id)} status=${String(r.status)} ${timeField}=${String(r[timeField])}`) },
      "なし",
    );
  }

  console.log(`\n検査 ${checks}項目 / 指摘 ${findings}件`);
  // 指摘があっても異常終了にはしない —— 「今どうなっているか」を出すのが
  // 目的で、修復するかどうかは業務判断だから。
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[verify-data-integrity] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

/**
 * 2026-09-03 追加指示 §26/§38 の実データ回帰。
 *
 *   AWS_PROFILE=Bello npm run verify:inquiry-live-case
 *
 * **読み取り専用**(DynamoDBのScan/GetItemのみ)。AIも呼ばない。
 *
 * ── 何を確かめるのか ────────────────────────────────────────────
 *
 * 今回の不具合は文章の質ではなく、
 *
 *     BASE URL → 商品特定 → 在庫取得 → サイズが無い → BASEから補完 →
 *     配送先 → 送料 → 値下げ判断
 *
 * という**配線**が途中で切れていたことだった。切れていた箇所を実データで
 * 1つずつ追い、最後まで繋がっていることを機械的に確かめる。
 *
 * 実データが前提を満たさない場合(該当BASE商品が消えている等)は、
 * 「確かめられなかった」と明示して終わる —— 条件が無いのに合格と表示する
 * ほうが有害だから。
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { extractBaseItemId, extractUrls, isBaseUrl } from "@/lib/inquiry/references";
import { extractNegotiation } from "@/lib/inquiry/negotiation";
import { extractShippingDestination } from "@/lib/inquiry/shippingIntent";
import {
  descriptionToPlainText,
  extractDimensionsFromText,
} from "@/lib/inquiry/productDetailExtraction";
import { calculateShippingRankFromDimensions } from "@/lib/shipping/rank";
import {
  addPendingQuestions,
  clearPendingQuestions,
  detectAskedQuestions,
  emptyConversationContext,
  mergeConversationContext,
} from "@/lib/inquiry/conversationContext";
import { resolvePendingAnswers } from "@/lib/inquiry/pendingAnswer";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

/** 実ケースの入力(利用者から共有されたもの)。 */
const BASE_URL = "https://bellointeri.base.shop/items/156144635";
const STEP1 = `${BASE_URL}\n3万円まで下げられますか？`;
const STEP2 = "埼玉です";

let failures = 0;
let passes = 0;
let skipped = 0;

function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label: string, why: string) {
  skipped++;
  console.log(`− SKIP ${label} — ${why}`);
}

/* ── テーブル名の解決(verify-negotiation-case.ts と同じ方法) ────── */

let cachedNames: string[] | null = null;
async function listAllTableNames(): Promise<string[]> {
  if (cachedNames) return cachedNames;
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  return (cachedNames = names);
}

const REQUIRED_MODELS = ["Inventory", "BaseProductArchive", "ShippingRate", "Conversation"];
let cachedApiId: string | null = null;
async function resolveApiId(): Promise<string> {
  if (cachedApiId) return cachedApiId;
  const names = await listAllTableNames();
  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()]
    .filter(([, s]) => REQUIRED_MODELS.every((r) => s.has(r)))
    .map(([a]) => a);
  if (complete.length !== 1) throw new Error(`Amplify Data APIを一意に決められません(候補${complete.length}件)`);
  return (cachedApiId = complete[0]);
}

async function table(model: string): Promise<string> {
  const apiId = await resolveApiId();
  const names = await listAllTableNames();
  const hits = names.filter((n) => n.startsWith(`${model}-${apiId}-`));
  if (hits.length !== 1) throw new Error(`${model} のテーブルを一意に決められません`);
  return hits[0];
}

async function scanAll<T>(t: string, extra: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = (await ddb.send(new ScanCommand({ TableName: t, ExclusiveStartKey: key, ...extra }))) as {
      Items?: T[];
      LastEvaluatedKey?: Record<string, unknown>;
    };
    out.push(...((res.Items ?? []) as T[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return out;
}

/* ══════════════════════════════════════════════════════════════════ */

interface ArchiveRow {
  baseItemId: string;
  title?: string | null;
  titleCore?: string | null;
  price?: number | null;
  detailText?: string | null;
  detailRaw?: string | null;
  itemUrl?: string | null;
}

interface InventoryRow {
  id: string;
  name: string;
  sku?: string | null;
  width?: string | null;
  depth?: string | null;
  height?: string | null;
  salePrice?: number | null;
  plannedSalePrice?: number | null;
  purchasePrice?: number | null;
  saleStartDate?: string | null;
}

interface ShippingRateRow {
  destinationPrefecture: string;
  rank: string;
  price?: number | null;
  surcharge?: number | null;
}

async function main() {
  console.log("=== 実データ回帰: BASE URL + 値下げ希望 → 「埼玉です」 ===\n");

  // ── ① 本文からの抽出(実データ不要) ───────────────────────
  const baseIds = extractUrls(STEP1)
    .filter(isBaseUrl)
    .map((u) => extractBaseItemId(u))
    .filter((v): v is string => v != null);
  check(baseIds.length === 1 && baseIds[0] === "156144635", "① BASE URLから商品IDを取り出せる", baseIds.join(","));

  const negotiation = extractNegotiation(STEP1);
  check(negotiation.isNegotiation, "① 値下げ交渉として判定される", negotiation.signals.join(" / "));
  check(negotiation.requestedTotalPriceYen === 30000, "① 希望価格 30,000円", String(negotiation.requestedTotalPriceYen));

  // ── ② BASE商品(実データ) ───────────────────────────────
  const archiveTable = await table("BaseProductArchive");
  const archived = (
    await ddb.send(new GetCommand({ TableName: archiveTable, Key: { baseItemId: baseIds[0] } }))
  ).Item as ArchiveRow | undefined;

  if (!archived) {
    skip("② BASE取り込み済みデータから商品を引く", `baseItemId ${baseIds[0]} が BaseProductArchive に無い`);
    console.log(
      "\n  実運用では、この場合 lib/inquiry/baseProductLookup.ts が BASE API へ直接問い合わせます。" +
        "\n  このスクリプトは読み取り専用のためAPIは叩きません。",
    );
  } else {
    check(true, "② BASE商品を特定できる", `${archived.title ?? "(タイトル無し)"} / ${archived.price ?? "価格不明"}円`);
  }

  // ── ③ 在庫(実データ) ───────────────────────────────────
  const inventories = await scanAll<InventoryRow>(await table("Inventory"));
  console.log(`\n  在庫 ${inventories.length} 件を読み込みました。`);

  // 商品名で突き合わせる(BASEの商品名 → 在庫)。
  const titleCore = (archived?.titleCore ?? archived?.title ?? "").trim();
  const matched = titleCore
    ? inventories.filter((i) => i.name && titleCore.length > 4 && i.name.includes(titleCore.slice(0, 8)))
    : [];

  let inventory: InventoryRow | null = matched.length === 1 ? matched[0] : null;
  if (matched.length > 1) {
    console.log(`  同名候補が ${matched.length} 件(§24 の「BASEはRESOLVED、在庫はAMBIGUOUS」に相当)`);
    inventory = matched[0];
  }

  // ── ④ サイズがどこにあるか ───────────────────────────────
  const inventoryDims = inventory
    ? calculateShippingRankFromDimensions(inventory.width ?? null, inventory.depth ?? null, inventory.height ?? null)
    : null;

  const baseText = descriptionToPlainText(archived?.detailText ?? archived?.detailRaw ?? "");
  const baseDims = extractDimensionsFromText(baseText);

  if (inventory) {
    console.log(
      `  対象在庫: ${inventory.name}\n` +
        `    在庫の寸法: 幅=${inventory.width ?? "—"} 奥行=${inventory.depth ?? "—"} 高さ=${inventory.height ?? "—"}`,
    );
  }
  console.log(`    BASE説明からの寸法: ${baseDims ? `${baseDims.widthCm} / ${baseDims.depthCm} / ${baseDims.heightCm} (${baseDims.confidence})` : "読み取れず"}`);

  // ── ⑤ 統合して送料まで出せるか ───────────────────────────
  const mergedWidth = inventoryDims ? (inventory!.width ?? null) : (baseDims?.widthCm ?? null);
  const mergedDepth = inventoryDims ? (inventory!.depth ?? null) : (baseDims?.depthCm ?? null);
  const mergedHeight = inventoryDims ? (inventory!.height ?? null) : (baseDims?.heightCm ?? null);
  const mergedDims = calculateShippingRankFromDimensions(mergedWidth, mergedDepth, mergedHeight);

  const sizeSource = inventoryDims ? "在庫データ" : baseDims ? "BASE商品ページ" : null;

  if (!mergedDims) {
    if (!archived) {
      skip("⑤ 統合した寸法で配送ランクを判定する", "BASE商品が取り込み済みデータに無く、寸法の出所が無い");
    } else {
      check(false, "⑤ 統合した寸法で配送ランクを判定する", "在庫にもBASEの商品説明にも3辺そろった寸法が無い");
    }
  } else {
    check(true, `⑤ 統合した寸法で配送ランクを判定できる(出典: ${sizeSource})`, `${mergedDims.sumCm}cm → ${mergedDims.rank}ランク`);
  }

  // ── ⑥ 配送先 + 料金マスタ ────────────────────────────────
  const destination = extractShippingDestination(STEP2);
  check(destination.prefecture === "埼玉県", "⑥ 「埼玉です」から配送先を読み取れる", String(destination.prefecture));

  if (mergedDims && destination.prefecture) {
    const rates = await scanAll<ShippingRateRow>(await table("ShippingRate"), {
      FilterExpression: "destinationPrefecture = :p AND #r = :r",
      ExpressionAttributeNames: { "#r": "rank" },
      ExpressionAttributeValues: { ":p": destination.prefecture, ":r": mergedDims.rank },
    });
    if (rates.length === 0) {
      check(
        false,
        "⑥ 想定送料を出せる",
        `料金マスタに 埼玉県 → ${destination.prefecture}・${mergedDims.rank}ランク の行が無い(金額は推測しない)`,
      );
    } else if (rates[0].price == null) {
      check(false, "⑥ 想定送料を出せる", "公式にサービス対象外と登録されている");
    } else {
      const fee = rates[0].price + (rates[0].surcharge ?? 0);
      check(true, "⑥ 想定送料を出せる(「不明」にならない)", `${fee.toLocaleString("ja-JP")}円`);
    }
  } else {
    skip("⑥ 想定送料を出せる", "寸法か配送先が確定していない");
  }

  // ── ⑦ 会話文脈が2ターン目で失われないか ─────────────────
  let context = mergeConversationContext(emptyConversationContext(), {
    channel: "LINE",
    intents: ["NEGOTIATION"],
    identifiedProduct: {
      baseItemId: baseIds[0],
      baseItemUrl: BASE_URL,
      baseProductName: archived?.title ?? null,
      baseListedPriceYen: archived?.price ?? null,
      baseStatus: archived ? "RESOLVED" : "NOT_FOUND",
      inventoryId: inventory?.id ?? null,
      inventoryStatus: matched.length === 1 ? "RESOLVED" : matched.length > 1 ? "AMBIGUOUS" : "NOT_FOUND",
    },
    negotiation: {
      active: true,
      requestedTotalPriceYen: negotiation.requestedTotalPriceYen,
      requestedUnitPriceYen: negotiation.requestedUnitPriceYen,
      quantity: negotiation.quantity,
      currentUnitPriceYen: inventory?.salePrice ?? inventory?.plannedSalePrice ?? archived?.price ?? null,
    },
  });
  context = addPendingQuestions(
    context,
    detectAskedQuestions("お届け先の都道府県を教えていただけますでしょうか。", new Date().toISOString()),
  );

  const answers = resolvePendingAnswers({ context, messageText: STEP2 });
  check(answers.length === 1, "⑦ 「埼玉です」を確認事項への回答として読む", answers.map((a) => a.value).join(","));

  context = clearPendingQuestions(context, answers.map((a) => a.field));
  context = mergeConversationContext(context, { shipping: { prefecture: "埼玉県" } });

  check(context.identifiedProduct.baseItemId === baseIds[0], "⑦ 2通目でも商品を失わない");
  check(context.identifiedProduct.baseItemUrl === BASE_URL, "⑦ 2通目でもBASE URLを失わない");
  check(context.negotiation.requestedTotalPriceYen === 30000, "⑦ 2通目でも希望価格を失わない");
  check(context.shipping.prefecture === "埼玉県", "⑦ 配送先だけが更新される");
  check(context.pendingQuestions.length === 0, "⑦ 確認待ちが解消する");

  // ── ⑧ 補完が実データでどれだけ効くか(§29/§40) ──────────────
  //
  // 1件の実ケースだけでは「たまたま動いた」と区別が付かない。取り込み済みの
  // BASE商品すべてについて、商品説明から寸法を読めるかを数える。
  // **読めない件数も出す** —— 効果を大きく見せない。
  console.log("\n── ⑧ BASE商品説明からの寸法抽出(実データ全件) ──");
  const allArchive = await scanAll<ArchiveRow>(archiveTable);
  let withDims = 0;
  let lowConfidence = 0;
  const examples: string[] = [];
  for (const row of allArchive) {
    const text = descriptionToPlainText(row.detailText ?? row.detailRaw ?? "");
    const dims = extractDimensionsFromText(text);
    if (!dims) continue;
    withDims++;
    if (dims.confidence === "LOW") lowConfidence++;
    if (examples.length < 3) {
      examples.push(`${row.baseItemId}: ${dims.matchedText} → ${dims.widthCm}/${dims.depthCm}/${dims.heightCm}`);
    }
  }
  console.log(`  BASE取り込み済み ${allArchive.length} 件のうち、商品説明から3辺そろった寸法を読めたのは ${withDims} 件`);
  console.log(`  そのうち信頼度LOW(ラベル無しのため要確認)は ${lowConfidence} 件`);
  for (const e of examples) console.log(`    例) ${e}`);
  check(allArchive.length > 0, "⑧ BASE取り込み済みデータを読めた", `${allArchive.length}件`);

  // 送料まで出せるようになる件数(在庫に寸法が無く、BASEにはある商品)。
  const byName = new Map<string, InventoryRow>();
  for (const inv of inventories) if (inv.name) byName.set(inv.name.trim(), inv);
  let newlyShippable = 0;
  for (const row of allArchive) {
    const title = (row.title ?? "").trim();
    const inv = byName.get(title);
    if (!inv) continue;
    if (calculateShippingRankFromDimensions(inv.width ?? null, inv.depth ?? null, inv.height ?? null)) continue;
    const dims = extractDimensionsFromText(descriptionToPlainText(row.detailText ?? row.detailRaw ?? ""));
    if (dims && calculateShippingRankFromDimensions(dims.widthCm, dims.depthCm, dims.heightCm)) newlyShippable++;
  }
  console.log(`  商品名が完全一致する在庫のうち、在庫に寸法が無くBASEから補えるのは ${newlyShippable} 件`);

  console.log(`\n${passes} passed, ${failures} failed, ${skipped} skipped`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n実データ回帰を実行できませんでした:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

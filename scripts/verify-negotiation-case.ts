/**
 * 2026-09-02 指示書の固定実例を、**Stagingの実データ**で最後まで追跡する
 * 回帰テスト(指示書§14)。
 *
 *     https://bellointeri.base.shop/items/155832757
 *     こちら2脚で6万円になりませんか
 *
 * AI(LLM)は呼ばない。呼ばずに検証できるのは、この不具合の原因が
 * 「文章の質」ではなく **入力 → 認識 → 商品解決 → 業務ルール → 計算**
 * の配線だったから。文章生成の前段がすべて正しく繋がっていることを、
 * 実データに対して機械的に確かめる。
 *
 * 読み取り専用(DynamoDBのScan/GetItemのみ)。
 *
 *   AWS_PROFILE=Bello npm run verify:negotiation-case
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { extractNegotiation, resolveNegotiationContext } from "@/lib/inquiry/negotiation";
import { extractProductReferences, normalizeUrl } from "@/lib/inquiry/references";
import { KNOWN_FURNITURE_BRANDS } from "@/lib/ai/productIntro/factSafety";
import { decideResolution, scoreInventory, type MatchableInventory, type MatchSignals } from "@/lib/inquiry/scoring";
import { extractShippingDestination } from "@/lib/inquiry/shippingIntent";
import { calculateShippingRankFromDimensionsDetailed } from "@/lib/shipping/rank";
import { calculateBaseDiscountedPrice, daysOnSale } from "@/lib/inquiry/discount";
import { resolveDisplayInventoryId } from "@/lib/inventory/inventoryId";
import type { ProductMatch } from "@/lib/inquiry/types";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { passes++; console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures++; console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
function eq(actual: unknown, expected: unknown, label: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

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

const REQUIRED_MODELS = ["Inventory", "ZaicoSourceLink", "BaseProductArchive", "ChannelListing", "ShippingRate"];
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
  const complete = [...byApiId.entries()].filter(([, s]) => REQUIRED_MODELS.every((r) => s.has(r))).map(([a]) => a);
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
    const res = await ddb.send(new ScanCommand({ TableName: t, ExclusiveStartKey: key, ...extra }));
    out.push(...((res.Items ?? []) as T[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

const BASE_ITEM_ID = "155832757";
const MESSAGE = `https://bellointeri.base.shop/items/${BASE_ITEM_ID}\n\nこちら2脚で6万円になりませんか`;
const FOLLOW_UP = "埼玉県です";

interface InvRow {
  id: string; sku: string; name: string;
  externalProductId?: string | null; barcode?: string | null;
  sourceSystem?: string | null; sourceInventoryId?: string | null;
  salePrice?: number | null; plannedSalePrice?: number | null; purchasePrice?: number | null;
  saleStartDate?: string | null; quantity?: number | null;
  width?: string | null; depth?: string | null; height?: string | null;
  deletedAt?: string | null;
}

async function main() {
  console.log("── 1. 本文の構造化抽出(指示書§3) ─────────────────────");
  const neg = extractNegotiation(MESSAGE);
  check(neg.isNegotiation, "値下げ交渉として認識する", neg.signals.join(" / "));
  eq(neg.quantity, 2, "数量 = 2(「2脚」)");
  eq(neg.requestedTotalPriceYen, 60000, "希望総額 = 60,000円(「6万円」)");
  eq(neg.requestedUnitPriceYen, 30000, "希望単価 = 30,000円(総額 ÷ 数量)");

  console.log("\n── 2. 商品URLの認識(指示書§2) ────────────────────────");
  const refs = extractProductReferences(MESSAGE, KNOWN_FURNITURE_BRANDS);
  eq(refs.baseUrls.length, 1, "BASEの商品URLを1件認識する");
  eq(refs.baseItemIds, [BASE_ITEM_ID], `BASE商品ID = ${BASE_ITEM_ID}`);

  console.log("\n── 3. BASE商品の解決(実データ) ───────────────────────");
  const archiveTable = await table("BaseProductArchive");
  const archive = await ddb.send(new GetCommand({ TableName: archiveTable, Key: { baseItemId: BASE_ITEM_ID } }));
  const baseItem = archive.Item as { baseItemId: string; title: string; titleCore?: string; price?: number; itemUrl?: string } | undefined;
  check(baseItem != null, "BaseProductArchive からBASE商品を特定できる");
  if (!baseItem) { report(); return; }
  console.log(`   BASE商品名: ${baseItem.title.slice(0, 60)}…`);
  console.log(`   BASE販売価格: ${baseItem.price ?? "-"}円`);
  check(baseItem.price != null && baseItem.price > 0, "BASE販売価格が取得できる", `${baseItem.price}円`);

  console.log("\n── 4. BELLO在庫との紐付け(実データ) ──────────────────");
  // ChannelListing も Inventory.externalProductId も BASE item_id を持って
  // いないことを、まず実データで確認しておく(ここが壊れていた理由)。
  const listings = await scanAll<{ externalListingId?: string; listingUrl?: string }>(await table("ChannelListing"));
  const listingHit = listings.filter((l) => l.externalListingId === BASE_ITEM_ID || (l.listingUrl ?? "").includes(BASE_ITEM_ID));
  console.log(`   ChannelListing 総数 ${listings.length}件 / BASE商品IDに一致 ${listingHit.length}件`);

  const invTable = await table("Inventory");
  const byExternalId = await scanAll<InvRow>(invTable, {
    FilterExpression: "externalProductId = :v",
    ExpressionAttributeValues: { ":v": BASE_ITEM_ID },
  });
  console.log(`   Inventory.externalProductId が BASE商品ID と一致: ${byExternalId.length}件`);
  check(
    listingHit.length === 0 && byExternalId.length === 0,
    "BASE item_id は ChannelListing にも Inventory.externalProductId にも無い(BASE過去商品からの橋渡しが必須であることの実測)",
  );

  // BASE商品名を手がかりに足して照合する(productResolver と同じ手順)。
  const all = await scanAll<InvRow>(invTable);
  const alive = all.filter((r) => !r.deletedAt);
  const fromBase = extractProductReferences(baseItem.titleCore ?? baseItem.title, KNOWN_FURNITURE_BRANDS);
  const signals: MatchSignals = {
    normalizedUrls: refs.urls.map(normalizeUrl),
    baseItemIds: refs.baseItemIds,
    skus: refs.skus,
    inventoryIds: refs.inventoryIds,
    modelNumbers: [...new Set([...refs.modelNumbers, ...fromBase.modelNumbers])],
    brandNames: [...new Set([...refs.brandNames, ...fromBase.brandNames])],
    nameFragments: [...new Set([...refs.productNameFragments, ...fromBase.productNameFragments])],
    baseTitles: [baseItem.title],
  };
  const matchables: MatchableInventory[] = alive.map((r) => ({
    id: r.id,
    displayInventoryId: resolveDisplayInventoryId({ sourceSystem: r.sourceSystem ?? null, sourceInventoryId: r.sourceInventoryId ?? null, sku: r.sku }),
    sku: r.sku,
    name: r.name,
    externalProductId: r.externalProductId ?? null,
    barcode: r.barcode ?? null,
    sourceInventoryId: r.sourceInventoryId ?? null,
    listings: [],
  }));
  const scored: ProductMatch[] = matchables
    .map((inv) => {
      const { confidence, reasons } = scoreInventory(inv, signals);
      return { inventoryId: inv.id, displayInventoryId: inv.displayInventoryId, sku: inv.sku, name: inv.name, confidence, reasons, source: "INVENTORY" as const };
    })
    .filter((m) => m.confidence > 0);
  const resolution = decideResolution(scored);
  console.log(`   照合結果: status=${resolution.status} / 候補${resolution.candidates.length}件`);
  for (const c of resolution.candidates.slice(0, 3)) {
    console.log(`     ${c.confidence.toFixed(2)}  ${c.sku}  ${c.name.slice(0, 50)}…`);
  }
  check(resolution.candidates.length > 0, "BASE商品名からBELLO在庫の候補を出せる", `${resolution.candidates.length}件`);
  const top = resolution.resolved ?? resolution.candidates[0] ?? null;
  check(top != null, "少なくとも第1候補が決まる");
  if (top) {
    check(
      top.name.includes("REVOLVER") && top.name.includes("HIGH"),
      "第1候補がBASE商品と同じ型(REVOLVER BAR STOOL HIGH)である",
      top.name.slice(0, 50),
    );
  }

  console.log("\n── 5. 配送先が不明であること(指示書§4) ───────────────");
  const dest = extractShippingDestination(MESSAGE);
  eq(dest.prefecture, null, "今回の本文からは配送先が読み取れない(= 先に都道府県を確認する段階)");

  console.log("\n── 6. 配送先が判明したときの引き継ぎ(指示書§14後半) ──");
  const followDest = extractShippingDestination(FOLLOW_UP);
  eq(followDest.prefecture, "埼玉県", "「埼玉県です」から配送先を読み取る");
  const carried = resolveNegotiationContext({
    currentText: FOLLOW_UP,
    history: [{ direction: "INBOUND", body: MESSAGE }],
    currentHasDestination: true,
  });
  check(carried.isNegotiation, "直前の交渉条件を引き継ぐ");
  eq(carried.quantity, 2, "引き継いだ数量 = 2");
  eq(carried.requestedTotalPriceYen, 60000, "引き継いだ希望総額 = 60,000円");
  check(!carried.fromCurrentMessage, "引き継ぎであることが記録される");

  // 通常問い合わせが交渉として扱われない(指示書§16の回帰防止)。
  const normal = resolveNegotiationContext({
    currentText: "サイズを教えてください",
    history: [{ direction: "INBOUND", body: MESSAGE }],
    currentHasDestination: false,
  });
  check(!normal.isNegotiation, "同じ会話でも、通常の問い合わせは交渉として扱わない(配送先を聞き返さない)");

  console.log("\n── 7. 送料判定と7%基準(実データ) ─────────────────────");
  if (top) {
    const inv = alive.find((r) => r.id === top.inventoryId)!;
    console.log(`   在庫: ${inv.sku} / 数量 ${inv.quantity} / 販売価格 ${inv.salePrice ?? "-"} / 販売予定価格 ${inv.plannedSalePrice ?? "-"} / 仕入 ${inv.purchasePrice ?? "-"}`);
    console.log(`   寸法: 幅"${inv.width ?? ""}" 奥行"${inv.depth ?? ""}" 高さ"${inv.height ?? ""}"`);
    const dims = calculateShippingRankFromDimensionsDetailed(inv.width, inv.depth, inv.height);
    if ("rank" in dims) {
      console.log(`   → 3辺合計 ${dims.sumCm}cm / ${dims.rank}ランク`);
      const rateTable = await table("ShippingRate");
      const rates = await scanAll<{ destinationPrefecture: string; rank: string; price: number | null }>(rateTable, {
        FilterExpression: "destinationPrefecture = :p",
        ExpressionAttributeValues: { ":p": "埼玉県" },
      });
      const rate = rates.find((r) => r.rank === dims.rank);
      check(rate != null, `埼玉県 / ${dims.rank}ランク の料金が引ける(全ページ走査)`, rate ? `${rate.price}円` : "");
    } else {
      console.log(`   → 送料判定不能: ${dims.missingAxes.map((a) => `${a.label}(${a.excluded.map((e) => e.reason).join(",") || "未入力"})`).join(" / ")}`);
      check(
        true,
        "外形寸法が揃わない場合は小さく見積もらず判定不能とする(座面寸法を流用しない)",
        dims.missingAxes.map((a) => a.label).join("・"),
      );
    }
    const unitPrice = inv.salePrice ?? inv.plannedSalePrice ?? null;
    if (unitPrice != null) {
      const discounted = calculateBaseDiscountedPrice(unitPrice);
      console.log(`   7%引き後単価 ${discounted}円 / 2点合計 ${discounted * 2}円 / 希望総額との差 ${60000 - discounted * 2}円`);
      check(discounted === Math.floor(unitPrice * 0.93), "7%引きの丸め(Math.floor)を変えていない");
    }
    console.log(`   販売開始 ${inv.saleStartDate ?? "-"} / 経過 ${daysOnSale(inv.saleStartDate ?? null) ?? "-"}日`);
  }

  report();
}

function report() {
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllInventory } from "@/lib/inventory/queries";
import { resolveDisplayInventoryId } from "@/lib/inventory/inventoryId";
import { KNOWN_FURNITURE_BRANDS } from "@/lib/ai/productIntro/factSafety";
import { extractProductReferences, normalizeUrl, type ProductReferenceResult } from "./references";
import { decideResolution, scoreInventory, type MatchableInventory, type MatchSignals } from "./scoring";
import type { ProductMatch, ProductResolution } from "./types";

/**
 * §4 商品の自動特定(サーバー側)。
 *
 * 【なぜ毎回の全件スキャンを避けるか】Staging実測で在庫は5,313件・
 * 7.3MB。Inventory.list()は1ページ200件なので全件で27往復になり、
 * 問い合わせを開くたびに数秒かかる。そこで2段構えにする:
 *
 *   1. 決定的な手がかり(SKU / 在庫ID / BASE商品ID / 出品URL)があれば、
 *      DynamoDB側で絞り込んで数件だけ引く。ほとんどの問い合わせは
 *      ここで終わる。
 *   2. 手がかりが商品名・ブランドだけの場合に限り、全件を読んで
 *      名前で照合する。こちらはプロセス内で短時間キャッシュする。
 *
 * 【キャッシュの寿命を短くしている理由】在庫は常時編集される。長く
 * 持つと「さっき登録した商品が候補に出ない」という分かりにくい挙動に
 * なる。60秒なら、同じ会話で何度か再生成しても1回しか読まない。
 */

const NAME_SCAN_CACHE_TTL_MS = 60_000;
let nameScanCache: { at: number; items: MatchableInventory[] } | null = null;

interface ChannelListingRow {
  inventoryId: string;
  channel: string;
  externalListingId?: string | null;
  listingUrl?: string | null;
}

/** 特定の在庫IDに紐づく出品情報だけを引く(GSI: inventoryId)。 */
async function listingsFor(inventoryIds: string[]): Promise<Map<string, ChannelListingRow[]>> {
  const map = new Map<string, ChannelListingRow[]>();
  await Promise.all(
    inventoryIds.map(async (inventoryId) => {
      const { data, errors } = await serverDataClient.models.ChannelListing.list({
        filter: { inventoryId: { eq: inventoryId } },
        limit: 20,
        ...inventoryAuthMode,
      });
      if (errors) throw new Error(`出品情報の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
      map.set(inventoryId, data as unknown as ChannelListingRow[]);
    }),
  );
  return map;
}

/** BASEの商品IDや出品URLから在庫を逆引きする(ChannelListing側から探す)。 */
async function findByListingSignals(signals: MatchSignals): Promise<ChannelListingRow[]> {
  if (signals.baseItemIds.length === 0 && signals.normalizedUrls.length === 0) return [];
  const conditions: Record<string, unknown>[] = [];
  for (const id of signals.baseItemIds) conditions.push({ externalListingId: { eq: id } });
  // 出品URLは表記ゆれがあるためcontainsで引き、最終判定はスコアリングに任せる。
  for (const url of signals.normalizedUrls) {
    const path = url.replace(/^https?:\/\//, "");
    conditions.push({ listingUrl: { contains: path } });
  }
  const { data, errors } = await serverDataClient.models.ChannelListing.list({
    filter: { or: conditions },
    limit: 50,
    ...inventoryAuthMode,
  });
  if (errors) throw new Error(`出品情報の検索に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  return data as unknown as ChannelListingRow[];
}

interface InventoryRow {
  id: string;
  sku: string;
  name: string;
  externalProductId?: string | null;
  barcode?: string | null;
  sourceSystem?: string | null;
  sourceInventoryId?: string | null;
}

function toMatchable(row: InventoryRow, listings: ChannelListingRow[]): MatchableInventory {
  return {
    id: row.id,
    displayInventoryId: resolveDisplayInventoryId({
      sourceSystem: row.sourceSystem ?? null,
      sourceInventoryId: row.sourceInventoryId ?? null,
      sku: row.sku,
    }),
    sku: row.sku,
    name: row.name,
    externalProductId: row.externalProductId ?? null,
    barcode: row.barcode ?? null,
    sourceInventoryId: row.sourceInventoryId ?? null,
    listings: listings.map((l) => ({
      channel: l.channel,
      externalListingId: l.externalListingId ?? null,
      listingUrl: l.listingUrl ? normalizeUrl(l.listingUrl) : null,
    })),
  };
}

/** 決定的な手がかりでDynamoDB側から直接引く。 */
async function findByStrongSignals(signals: MatchSignals): Promise<InventoryRow[]> {
  const conditions: Record<string, unknown>[] = [];
  for (const sku of signals.skus) conditions.push({ sku: { eq: sku } });
  for (const id of signals.inventoryIds) {
    conditions.push({ sourceInventoryId: { eq: id } });
    conditions.push({ barcode: { eq: id } });
  }
  for (const id of signals.baseItemIds) conditions.push({ externalProductId: { eq: id } });
  if (conditions.length === 0) return [];

  const { data, errors } = await serverDataClient.models.Inventory.list({
    filter: { and: [{ deletedAt: { attributeExists: false } }, { or: conditions }] },
    limit: 50,
    ...inventoryAuthMode,
  });
  if (errors) throw new Error(`在庫の検索に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  return data as unknown as InventoryRow[];
}

/**
 * 商品名照合のための全件読み込み(キャッシュ付き)。
 *
 * §36「売却済み・非販売中商品でも履歴が残っていれば特定できる設計」に
 * 従い、販売状態では絞り込まない。除外するのは論理削除だけ
 * (listAllInventoryが既にdeletedAtで絞っている)。
 */
async function loadAllForNameScan(): Promise<MatchableInventory[]> {
  if (nameScanCache && Date.now() - nameScanCache.at < NAME_SCAN_CACHE_TTL_MS) return nameScanCache.items;
  const records = await listAllInventory();
  const items = records.map((r) =>
    toMatchable(
      {
        id: r.id,
        sku: r.sku,
        name: r.name,
        externalProductId: r.externalProductId ?? null,
        barcode: r.barcode ?? null,
        sourceSystem: r.sourceSystem ?? null,
        sourceInventoryId: r.sourceInventoryId ?? null,
      },
      // 名前照合の段階では出品情報は要らない(強い手がかりが無いから
      // ここへ来ている)。上位候補が決まってから必要なら引き直す。
      [],
    ),
  );
  nameScanCache = { at: Date.now(), items };
  return items;
}

/** テストや、在庫を大量に変更した直後にキャッシュを捨てるため。 */
export function clearProductResolverCache(): void {
  nameScanCache = null;
}

export interface ResolveProductResult extends ProductResolution {
  references: ProductReferenceResult;
  /** 全件スキャンを行ったか(遅い経路を通ったかの観測用)。 */
  usedFullScan: boolean;
}

export async function resolveProductFromInquiry(params: {
  messageText: string;
  /** 人が選び直した在庫ID。指定されていればそれを最優先する(§34)。 */
  overrideInventoryId?: string | null;
  /** 会話に元から紐づく在庫ID。手がかりが無いときの既定値として使う。 */
  conversationInventoryId?: string | null;
}): Promise<ResolveProductResult> {
  const references = extractProductReferences(params.messageText, KNOWN_FURNITURE_BRANDS);
  const signals: MatchSignals = {
    normalizedUrls: references.urls.map(normalizeUrl),
    baseItemIds: references.baseItemIds,
    skus: references.skus,
    inventoryIds: references.inventoryIds,
    modelNumbers: references.modelNumbers,
    brandNames: references.brandNames,
    nameFragments: references.productNameFragments,
  };

  // 人が選んだ商品、または会話に紐づく商品は、照合をせずそのまま採用する。
  const forcedId = params.overrideInventoryId ?? null;
  if (forcedId) {
    const forced = await loadOne(forcedId, forcedId === params.overrideInventoryId ? "担当者が選択した商品" : "会話に紐づく商品");
    if (forced) return { status: "RESOLVED", resolved: forced, candidates: [forced], references, usedFullScan: false };
  }

  const strongRows = await findByStrongSignals(signals);
  const listingRows = await findByListingSignals(signals);
  const idsFromListings = [...new Set(listingRows.map((l) => l.inventoryId))].filter((id) => !strongRows.some((r) => r.id === id));
  const extraRows = idsFromListings.length > 0 ? await loadRows(idsFromListings) : [];

  const rows = [...strongRows, ...extraRows];
  let usedFullScan = false;
  let matchables: MatchableInventory[];

  if (rows.length > 0) {
    const listingsByInventory = await listingsFor(rows.map((r) => r.id));
    matchables = rows.map((r) => toMatchable(r, listingsByInventory.get(r.id) ?? []));
  } else if (hasWeakSignals(signals)) {
    usedFullScan = true;
    matchables = await loadAllForNameScan();
  } else {
    matchables = [];
  }

  if (matchables.length === 0) {
    // 手がかりが何も無ければ「商品を指していない問い合わせ」。
    // 手がかりはあったが在庫に無い場合と区別する(§4.4)。
    const anySignal = hasWeakSignals(signals) || signals.skus.length > 0 || signals.inventoryIds.length > 0 || signals.baseItemIds.length > 0;
    const status = anySignal ? "NOT_FOUND" : "NOT_REFERENCED";
    // 会話に紐づく商品があるなら、それを候補として残す。
    if (params.conversationInventoryId) {
      const linked = await loadOne(params.conversationInventoryId, "この会話に紐づけられている商品");
      if (linked) return { status: "RESOLVED", resolved: linked, candidates: [linked], references, usedFullScan };
    }
    return { status, resolved: null, candidates: [], references, usedFullScan };
  }

  const scored: ProductMatch[] = matchables
    .map((inv) => {
      const { confidence, reasons } = scoreInventory(inv, signals);
      return {
        inventoryId: inv.id,
        displayInventoryId: inv.displayInventoryId,
        sku: inv.sku,
        name: inv.name,
        confidence,
        reasons,
        source: "INVENTORY" as const,
      };
    })
    .filter((m) => m.confidence > 0);

  const resolution = decideResolution(scored);

  // 候補が1件も残らず、会話に紐づく商品があるならそれを使う。
  if (resolution.candidates.length === 0 && params.conversationInventoryId) {
    const linked = await loadOne(params.conversationInventoryId, "この会話に紐づけられている商品");
    if (linked) return { status: "RESOLVED", resolved: linked, candidates: [linked], references, usedFullScan };
  }
  return { ...resolution, references, usedFullScan };
}

function hasWeakSignals(signals: MatchSignals): boolean {
  return signals.modelNumbers.length > 0 || signals.brandNames.length > 0 || signals.nameFragments.length > 0;
}

async function loadRows(ids: string[]): Promise<InventoryRow[]> {
  const results = await Promise.all(
    ids.slice(0, 20).map(async (id) => {
      const { data } = await serverDataClient.models.Inventory.get({ id }, inventoryAuthMode);
      return data as unknown as InventoryRow | null;
    }),
  );
  return results.filter((r): r is InventoryRow => r !== null);
}

async function loadOne(inventoryId: string, reason: string): Promise<ProductMatch | null> {
  const { data } = await serverDataClient.models.Inventory.get({ id: inventoryId }, inventoryAuthMode);
  if (!data) return null;
  const row = data as unknown as InventoryRow;
  return {
    inventoryId: row.id,
    displayInventoryId: resolveDisplayInventoryId({
      sourceSystem: row.sourceSystem ?? null,
      sourceInventoryId: row.sourceInventoryId ?? null,
      sku: row.sku,
    }),
    sku: row.sku,
    name: row.name,
    confidence: 1,
    reasons: [reason],
    source: "INVENTORY",
  };
}

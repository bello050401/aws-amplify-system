import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
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

/**
 * 決定的な手がかりでDynamoDB側から直接引く。
 *
 * 【limit を外し、全ページ辿る理由】DynamoDBの Limit は**フィルタ適用前**
 * に読む件数の上限。`limit: 50` を付けたフィルタ付きlistは「先頭50行を
 * 読んで、その中で条件に合ったもの」しか返さない —— Inventory は5,313件
 * あるので、SKUや在庫IDが完全一致していても**ほぼ確実に0件**になる。
 * ShippingRateで実測したのと同じ不具合(lib/amplify/listAll.ts 参照)。
 */
async function findByStrongSignals(signals: MatchSignals): Promise<InventoryRow[]> {
  const conditions: Record<string, unknown>[] = [];
  for (const sku of signals.skus) conditions.push({ sku: { eq: sku } });
  for (const id of signals.inventoryIds) {
    conditions.push({ sourceInventoryId: { eq: id } });
    conditions.push({ barcode: { eq: id } });
  }
  for (const id of signals.baseItemIds) conditions.push({ externalProductId: { eq: id } });
  if (conditions.length === 0) return [];

  return listAllPages<InventoryRow>(
    async (nextToken) => {
      const res = await serverDataClient.models.Inventory.list({
        filter: { and: [{ deletedAt: { attributeExists: false } }, { or: conditions }] },
        limit: 1000,
        nextToken,
        ...inventoryAuthMode,
      });
      return { data: res.data as unknown as InventoryRow[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "在庫の検索" },
  );
}

/**
 * BASE商品IDから、取り込み済みのBASE過去商品(BaseProductArchive、267件)を引く。
 *
 * ── なぜこれが必要になったか(実測) ────────────────────────────────
 *
 * 固定実例のURL https://bellointeri.base.shop/items/155832757 について、
 * 2026-09-02 に Staging の実データを数えた:
 *
 *   ChannelListing                              0件(テーブルが空)
 *   Inventory.externalProductId = "155832757"   0件
 *   BaseProductArchive.baseItemId = "155832757" 1件 ← ここにだけ在る
 *
 * Inventory.externalProductId に入っているのは ZAICO の「⚫︎商品ID」で、
 * 実際の値はメルカリ/ヤフオクの商品ID(m63764357338 / o1234277060 等)。
 * BASEの item_id は**どこにも紐付いていなかった**。つまり BASE URL から
 * 在庫へ辿る経路が構造的に存在しなかった —— これが「商品を特定できず、
 * 一般的な値引き不可の文面になった」の入口側の原因。
 *
 * BaseProductArchive には商品名(title)があるので、そこから商品名照合へ
 * 橋渡しする。BASE商品自体は確実に特定できるので、在庫への紐付けが
 * 未確定でも「どこまで特定できたか」を管理者へ出せる。
 */
export interface BaseArchiveMatch {
  baseItemId: string;
  title: string;
  titleCore: string | null;
  price: number | null;
  itemUrl: string | null;
}

async function findBaseArchive(baseItemIds: string[]): Promise<BaseArchiveMatch[]> {
  if (baseItemIds.length === 0) return [];
  const rows = await Promise.all(
    baseItemIds.slice(0, 5).map(async (baseItemId) => {
      // identifier が baseItemId なので get で一意に引ける(Scanしない)。
      const { data } = await serverDataClient.models.BaseProductArchive.get({ baseItemId }, inventoryAuthMode);
      if (!data) return null;
      return {
        baseItemId: data.baseItemId,
        title: data.title,
        titleCore: data.titleCore ?? null,
        price: data.price ?? null,
        itemUrl: data.itemUrl ?? null,
      } satisfies BaseArchiveMatch;
    }),
  );
  return rows.filter((r): r is BaseArchiveMatch => r !== null);
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
  /**
   * 問い合わせのURLから特定できたBASE商品(BaseProductArchive由来)。
   * 在庫への紐付けが未確定でも、ここまでは確実に特定できたことを示す。
   */
  baseProducts: BaseArchiveMatch[];
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
    if (forced) return { status: "RESOLVED", resolved: forced, candidates: [forced], references, usedFullScan: false, baseProducts: [] };
  }

  // BASE商品IDがあれば、まず取り込み済みのBASE過去商品から商品名を得る。
  // ChannelListing も Inventory.externalProductId も BASE item_id を
  // 持っていないため(findBaseArchive のコメントに実測値)、ここで得た
  // 商品名を照合の手がかりに足さないと在庫へ辿り着けない。
  const baseProducts = await findBaseArchive(signals.baseItemIds);
  if (baseProducts.length > 0) {
    // BASEの商品名から手がかりを取り出して足す。**事実として転記するの
    // ではなく、あくまで照合用の語**として扱う(値・寸法等は一切持ち込まない)。
    const fromBase = baseProducts.flatMap((b) => extractProductReferences(b.titleCore ?? b.title, KNOWN_FURNITURE_BRANDS));
    signals.brandNames = [...new Set([...signals.brandNames, ...fromBase.flatMap((f) => f.brandNames)])];
    signals.modelNumbers = [...new Set([...signals.modelNumbers, ...fromBase.flatMap((f) => f.modelNumbers)])];
    signals.nameFragments = [...new Set([...signals.nameFragments, ...fromBase.flatMap((f) => f.productNameFragments)])];
    // BASE商品ページの正式タイトルそのものも渡す。ブランド+語の断片の
    // 積み上げ(実測 0.52)では候補の下限 0.60 にすら届かず「候補0件」に
    // なっていた —— 正しい在庫が目の前にあるのに。詳細は
    // scoring.ts の MatchSignals.baseTitles のコメント。
    signals.baseTitles = baseProducts.map((b) => b.title);
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
      if (linked) return { status: "RESOLVED", resolved: linked, candidates: [linked], references, usedFullScan, baseProducts };
    }
    return { status, resolved: null, candidates: [], references, usedFullScan, baseProducts };
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
    if (linked) return { status: "RESOLVED", resolved: linked, candidates: [linked], references, usedFullScan, baseProducts };
  }
  return { ...resolution, references, usedFullScan, baseProducts };
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

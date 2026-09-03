import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
import { listAllInventory, listInventoryByCategory } from "@/lib/inventory/queries";
import { getOnSaleCategoryId, ON_SALE_CATEGORY_NAME } from "./onSaleCategory";
import { resolveDisplayInventoryId } from "@/lib/inventory/inventoryId";
import { KNOWN_FURNITURE_BRANDS } from "@/lib/ai/productIntro/factSafety";
import { extractProductReferences, normalizeUrl, type ProductReferenceResult } from "./references";
import { lookupBaseProducts } from "./baseProductLookup";
import { decideResolution, mergeSameProduct, scoreInventory, type MatchableInventory, type MatchSignals } from "./scoring";
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
  /** 在庫数。同一商品をまとめたときの内訳に出す。 */
  quantity?: number | null;
  externalProductId?: string | null;
  barcode?: string | null;
  sourceSystem?: string | null;
  sourceInventoryId?: string | null;
}

function toMatchable(row: InventoryRow, listings: ChannelListingRow[]): MatchableInventory {
  return {
    id: row.id,
    quantity: row.quantity ?? null,
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
  /**
   * 商品説明(2026-09-03 追加指示 §31)。在庫にサイズが無いとき、ここから
   * 寸法を補完して送料まで出す。持ち回らないと、同じBASE商品をもう一度
   * 引き直すことになる(BASE APIを2回叩く)。
   */
  description: string | null;
  /** archive(取り込み済み) か api(BASEへ問い合わせた現在値) か。出典として持つ。 */
  source: "archive" | "api";
}

/**
 * BASE商品IDから商品情報を引く。
 *
 * ── 取り込み済みデータだけでは足りない（実測） ──────────────────
 *
 * 以前はここが `BaseProductArchive` の get だけだった。しかしアーカイブは
 * **267件しか無い**（Staging実測）。指示書の実例 `156144635` も入って
 * いない。
 *
 * アーカイブに無いIDは商品名が1つも得られず、URLという最も確実な手がかりを
 * 持っているのに「該当なし」になっていた —— これが「BASE商品URLを送っても
 * 商品を特定できない」の正体。URL抽出そのものは正しく動いていた
 * （14通りのURLパターンで実測、失敗0件）。
 *
 * いまは lookupBaseProducts が、アーカイブに無ければ **BASE API へ直接
 * 聞く**（既存の getBaseClient().getItem を再利用。新しいクライアントは
 * 作っていない）。
 */
async function findBaseArchive(baseItemIds: string[]): Promise<BaseArchiveMatch[]> {
  if (baseItemIds.length === 0) return [];
  const found = await lookupBaseProducts(baseItemIds);
  return found
    .filter((f) => f.source !== "not-found" && f.title)
    .map(
      (f) =>
        ({
          baseItemId: f.baseItemId,
          title: f.title as string,
          titleCore: f.titleCore,
          price: f.price,
          itemUrl: f.itemUrl,
          description: f.description,
          source: f.source === "api" ? "api" : "archive",
        }) satisfies BaseArchiveMatch,
    );
}

/**
 * 商品名照合のための読み込み(キャッシュ付き)。
 *
 * ── 出品中(販売中)だけを見る(2026-09-03 利用者指示) ──────────────
 *
 * 「商品は出品中からしかこない」。お客様が問い合わせてくるのは販売ページに
 * 出ている商品だけなので、それ以外を候補に入れる意味が無い。
 *
 * 以前は §36「売却済み・非販売中商品でも履歴が残っていれば特定できる設計」に
 * 従って販売状態で絞っていなかったが、実測すると害のほうが大きかった:
 *
 *   - 発送完了(4,329件)に同名の過去在庫があり、1件に絞れず AMBIGUOUS になる
 *   - 5,313件を毎回走査するので遅い
 *
 * §36が守りたいのは「過去の取引について問い合わせが来ても分かること」だが、
 * それは会話に紐づく商品(conversationInventoryId)や、SKU・在庫IDといった
 * 決定的な手がかりの経路で拾える —— そちらは findByStrongSignals が
 * カテゴリに関係なく引く。**絞るのは商品名だけを頼りにする弱い経路に限る。**
 *
 * カテゴリを解決できなかった場合は絞り込みを諦めて全件を見る。ここで
 * 空を返すと、カテゴリ名が変わった瞬間に全問い合わせで商品が特定できなく
 * なり、しかも画面には「商品が見つからない」としか出ないため原因に
 * 辿り着けない。
 */
async function loadAllForNameScan(): Promise<MatchableInventory[]> {
  if (nameScanCache && Date.now() - nameScanCache.at < NAME_SCAN_CACHE_TTL_MS) return nameScanCache.items;
  const onSaleCategoryId = await getOnSaleCategoryId();
  if (!onSaleCategoryId) {
    console.warn(
      `[productResolver] カテゴリ「${ON_SALE_CATEGORY_NAME}」を解決できないため、出品中での絞り込みを行いません。`,
    );
  }
  const records = onSaleCategoryId ? await listInventoryByCategory(onSaleCategoryId) : await listAllInventory();
  const items = records.map((r) =>
    toMatchable(
      {
        id: r.id,
        sku: r.sku,
        name: r.name,
        quantity: r.quantity ?? null,
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
  /**
   * 販売チャネル側が持っている**正式な商品名**(2026-09-03 追加指示§4)。
   *
   * メルカリShopsの通知メールは商品URLを含まないが、出品時のタイトルを
   * そのまま載せてくる。これはBASEの商品タイトルと同じ性質の手がかり
   * (人が入力した曖昧な文字列ではなく、出品データそのもの)なので、
   * 本文から拾った語の断片ではなく**タイトルとして**照合へ渡す。
   *
   * ここを本文と同じ扱いにすると、名前の断片の積み上げにしかならず
   * 確定値(0.95)へ届かない —— 実際、メールから取り込んだ27件が
   * すべて NOT_FOUND / AMBIGUOUS になっていた。
   */
  productTitle?: string | null;
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
  // チャネル側の正式な商品名があれば、タイトルとして手がかりに足す。
  // BASE商品タイトルと同じ扱いにすることで、同じ高信頼の照合経路に乗る。
  if (params.productTitle?.trim()) {
    const title = params.productTitle.trim();
    signals.baseTitles = [...(signals.baseTitles ?? []), title];
    const fromTitle = extractProductReferences(title, KNOWN_FURNITURE_BRANDS);
    signals.brandNames = [...new Set([...signals.brandNames, ...fromTitle.brandNames])];
    signals.modelNumbers = [...new Set([...signals.modelNumbers, ...fromTitle.modelNumbers])];
    signals.nameFragments = [...new Set([...signals.nameFragments, ...fromTitle.productNameFragments])];
  }

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
    signals.baseTitles = [...(signals.baseTitles ?? []), ...baseProducts.map((b) => b.title)];
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
        quantity: inv.quantity ?? null,
      };
    })
    .filter((m) => m.confidence > 0);

  // 同じ商品が在庫の都合で複数行に分かれているだけなら、候補が割れたとは
  // 扱わない(2026-09-03 利用者指示)。判定の前にまとめる —— 後だと
  // AMBIGUOUS が確定してしまい、人の確認待ちのまま止まる。
  const resolution = decideResolution(mergeSameProduct(scored));

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

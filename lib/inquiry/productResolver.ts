import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
import { listAllInventory, listInventoryByCategory } from "@/lib/inventory/queries";
import { getInquiryCategoryScopes, ON_SALE_CATEGORY_NAME } from "./onSaleCategory";
import { getZaicoSyncFreshness } from "./zaicoSyncFreshness";
import { resolveDisplayInventoryId } from "@/lib/inventory/inventoryId";
import { KNOWN_FURNITURE_BRANDS } from "@/lib/ai/productIntro/factSafety";
import { extractProductReferences, normalizeUrl, type ProductReferenceResult } from "./references";
import { lookupBaseProducts } from "./baseProductLookup";
import {
  decideResolution,
  mergeSameProduct,
  OFFICIAL_TITLE_MATCH_PREFIX,
  scoreInventory,
  type MatchableInventory,
  type MatchSignals,
} from "./scoring";
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
let onSaleScanCache: { at: number; items: MatchableInventory[] } | null = null;
let fallbackScanCache: { at: number; items: MatchableInventory[] } | null = null;
/** 購入済み注文の照合用(販売中を外れた在庫まで含む)。 */
let orderScanCache: { at: number; items: MatchableInventory[] } | null = null;

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
 * ── 基本は出品中(販売中)だけ(2026-09-03 利用者指示) ──────────────
 *
 * 「商品は出品中からしかこない」。発送完了(4,329件)まで含めて照合して
 * いたため、同名の過去在庫が候補に混ざって1件に絞れず、かつ5,313件を
 * 毎回走査していた。
 *
 * §36「売却済み・非販売中商品でも履歴が残っていれば特定できる設計」が
 * 守りたいのは過去取引の問い合わせだが、それは会話への紐付けや
 * SKU・在庫IDといった決定的な手がかりの経路で拾える —— findByStrongSignals
 * はカテゴリに関係なく引く。**絞るのは商品名だけを頼りにする弱い経路に限る。**
 *
 * ── カテゴリを解決できないときは全件へ戻さない ──────────────────
 *
 * 以前はカテゴリ名を引けなければ全在庫(5,313件)へ黙って戻していた。
 * これは誤特定側に倒れる: 「販売中だけを見る」という前提で組んだ照合が、
 * 何も知らせずに発送完了まで含む範囲で動いてしまう。
 * **内部エラーとして扱い、候補を作らない。** BASE商品側の情報だけで
 * 処理は続けられるので、問い合わせ全体が止まるわけではない。
 */
async function loadOnSaleForNameScan(): Promise<{ items: MatchableInventory[]; categoryResolved: boolean }> {
  if (onSaleScanCache && Date.now() - onSaleScanCache.at < NAME_SCAN_CACHE_TTL_MS) {
    return { items: onSaleScanCache.items, categoryResolved: true };
  }
  const scopes = await getInquiryCategoryScopes();
  if (!scopes.onSaleCategoryId) {
    console.error(
      `[productResolver] カテゴリ「${ON_SALE_CATEGORY_NAME}」を解決できません。名前照合の候補を作らずに続行します。`,
    );
    return { items: [], categoryResolved: false };
  }
  const items = toMatchables(await listInventoryByCategory(scopes.onSaleCategoryId));
  onSaleScanCache = { at: Date.now(), items };
  return { items, categoryResolved: true };
}

/**
 * 同期遅れが疑われるときだけ見る、広めの候補集合。
 *
 * BELLOの在庫カテゴリはZAICO同期で入るため、BASEの出品状態より遅れる
 * ことがある。実測(2026-09-03)でも、BASEで出品中の
 * BoConcept Elba Lounge Chair の在庫は「五十嵐さん」「複数在庫 未出品」に
 * あり、販売中には1件も無かった。
 *
 * 明らかな過去在庫(発送完了・破棄・売り切れ)だけを除く。除きすぎると
 * フォールバックの意味が無くなるので、迷うもの(保留・補修待ち等)は残す。
 * 誤特定の抑止は**採用条件をBASE商品名の強い一致に限る**ことで担保する
 * (resolveProduct の acceptableForSyncLag)。
 */
async function loadSyncLagFallbackForNameScan(): Promise<MatchableInventory[]> {
  if (fallbackScanCache && Date.now() - fallbackScanCache.at < NAME_SCAN_CACHE_TTL_MS) return fallbackScanCache.items;
  const scopes = await getInquiryCategoryScopes();
  const past = new Set(scopes.pastCategoryIds);
  const records = (await listAllInventory()).filter((r) => !r.categoryId || !past.has(r.categoryId));
  const items = toMatchables(records);
  fallbackScanCache = { at: Date.now(), items };
  return items;
}

/**
 * **購入済みの注文**について商品を探すときの候補集合(2026-09-04 §50/§65)。
 *
 * ── なぜ「販売中」では絶対に見つからないのか ────────────────────
 *
 * 取引メッセージは購入後のやり取りなので、その商品は既に売れている。
 * BELLOの運用では売れた在庫は「発送完了」「売り切れ」へ移る。つまり
 * **注文の商品を「販売中」から探すのは、原理的に当たらない探し方**。
 *
 * 実測(2026-09-03、order_2JW2rNd9i7WdFrivCjhfpw): 出品タイトルと一致する
 * 在庫 B005614 は「発送完了」にあり、販売中スキャンでは0件だった。
 * 結果、社内通知は3通とも「対象商品：特定できませんでした」。
 *
 * ── 誤特定をどう抑えるか ────────────────────────────────────────
 *
 * 範囲を広げる代わりに、**採用条件を出品タイトルの一致だけに絞る**
 * (resolveProduct の acceptable フィルタ)。ブランド名や語の断片の
 * 積み上げで過去在庫を拾うことはない。「破棄」だけは除く —— そこに
 * 移った在庫は注文の対象になりえない。
 */
async function loadOrderScopeForNameScan(): Promise<MatchableInventory[]> {
  if (orderScanCache && Date.now() - orderScanCache.at < NAME_SCAN_CACHE_TTL_MS) return orderScanCache.items;
  const scopes = await getInquiryCategoryScopes();
  const discardedIds = new Set(
    scopes.pastCategoryIds.length > 0 ? await discardedCategoryIds() : [],
  );
  const records = (await listAllInventory()).filter((r) => !r.categoryId || !discardedIds.has(r.categoryId));
  const items = toMatchables(records);
  orderScanCache = { at: Date.now(), items };
  return items;
}

/** 「破棄」カテゴリのID。注文の対象になりえないものだけを除くために引く。 */
async function discardedCategoryIds(): Promise<string[]> {
  const { data, errors } = await serverDataClient.models.Category.list({ limit: 500, ...inventoryAuthMode });
  if (errors && errors.length > 0) return [];
  return ((data ?? []) as unknown as { id: string; name?: string | null }[])
    .filter((c) => c.name === "破棄")
    .map((c) => c.id);
}

function toMatchables(records: { id: string; sku: string; name: string; quantity?: number | null; externalProductId?: string | null; barcode?: string | null; sourceSystem?: string | null; sourceInventoryId?: string | null }[]): MatchableInventory[] {
  return records.map((r) =>
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
}

/** テストや、在庫を大量に変更した直後にキャッシュを捨てるため。 */
export function clearProductResolverCache(): void {
  onSaleScanCache = null;
  fallbackScanCache = null;
  orderScanCache = null;
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
  /**
   * 「販売中」カテゴリを解決できたか。false は内部エラー。
   *
   * 黙って全在庫へ広げない代わりに、解決できなかったことを呼び出し側へ
   * 伝える。担当者には【要確認】として出す —— 商品が見つからないのと
   * 「探す範囲を決められなかった」のは全く違う。
   */
  onSaleCategoryResolved: boolean;
  /**
   * ZAICO同期の未反映が疑われる状態で在庫を特定したか(2026-09-03 利用者指示)。
   *
   * BELLOの在庫カテゴリはZAICO同期で入るため、BASEの出品状態より遅れる。
   * 「販売中に無い」ことだけを理由に候補を0件にせず、BASE商品名の強い
   * 一致がある場合に限って範囲を広げて拾う。拾ったことは隠さない。
   */
  inventorySyncSuspected: boolean;
  /** 最後にZAICO同期が完了した時刻(判断材料として通知へ出す)。 */
  zaicoLastSyncedAt: string | null;
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
  /**
   * **購入済みの注文**についての照合か(2026-09-04 追加指示 §50/§65)。
   *
   * true なら、名前照合の範囲を「販売中」に限らない。購入された商品は
   * 「発送完了」等へ移っているので、販売中だけを見る既定の探し方では
   * 原理的に当たらない(loadOrderScopeForNameScan のコメントに実測)。
   * 誤特定を避けるため、広げた範囲から採るのは**出品タイトルが一致した
   * 候補だけ**に絞る。
   */
  purchasedOrder?: boolean;
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
    if (forced) {
      return {
        status: "RESOLVED",
        resolved: forced,
        candidates: [forced],
        references,
        usedFullScan: false,
        baseProducts: [],
        onSaleCategoryResolved: true,
        inventorySyncSuspected: false,
        zaicoLastSyncedAt: null,
      };
    }
  }

  // BASE商品IDがあれば、まず取り込み済みのBASE過去商品から商品名を得る。
  // ChannelListing も Inventory.externalProductId も BASE item_id を
  // 持っていないため(findBaseArchive のコメントに実測値)、ここで得た
  // 商品名を照合の手がかりに足さないと在庫へ辿り着けない。
  // チャネル側の正式な商品名があれば、タイトルとして手がかりに足す。
  // BASE商品タイトルと同じ扱いにすることで、同じ高信頼の照合経路に乗る。
  if (params.productTitle?.trim()) {
    const title = params.productTitle.trim();
    signals.officialTitles = [...(signals.officialTitles ?? []), title];
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
    // scoring.ts の MatchSignals.officialTitles のコメント。
    signals.officialTitles = [...(signals.officialTitles ?? []), ...baseProducts.map((b) => b.title)];
  }

  const strongRows = await findByStrongSignals(signals);
  const listingRows = await findByListingSignals(signals);
  const idsFromListings = [...new Set(listingRows.map((l) => l.inventoryId))].filter((id) => !strongRows.some((r) => r.id === id));
  const extraRows = idsFromListings.length > 0 ? await loadRows(idsFromListings) : [];

  const rows = [...strongRows, ...extraRows];
  let usedFullScan = false;
  let matchables: MatchableInventory[];
  // 名前照合を「販売中」に絞れたか。解決できないまま全件へ広げるのは
  // 誤特定側に倒れるので行わない(loadOnSaleForNameScan のコメント参照)。
  let onSaleCategoryResolved = true;

  if (rows.length > 0) {
    const listingsByInventory = await listingsFor(rows.map((r) => r.id));
    matchables = rows.map((r) => toMatchable(r, listingsByInventory.get(r.id) ?? []));
  } else if (hasWeakSignals(signals)) {
    usedFullScan = true;
    const onSale = await loadOnSaleForNameScan();
    matchables = onSale.items;
    onSaleCategoryResolved = onSale.categoryResolved;
  } else {
    matchables = [];
  }

  // 購入済み注文で出品タイトルがあるなら、まだ探す場所が残っている
  // (下の「購入済み注文の照合」)。ここで早期に NOT_FOUND を返すと
  // そこへ辿り着けない。**候補が空でも先へ進める**だけで、範囲を
  // 広げるのは向こう側 —— 採用条件(出品タイトルの一致)もそちらにある。
  const orderScopePending = Boolean(params.purchasedOrder) && (signals.officialTitles?.length ?? 0) > 0;

  if (matchables.length === 0 && !orderScopePending) {
    // 手がかりが何も無ければ「商品を指していない問い合わせ」。
    // 手がかりはあったが在庫に無い場合と区別する(§4.4)。
    const anySignal = hasWeakSignals(signals) || signals.skus.length > 0 || signals.inventoryIds.length > 0 || signals.baseItemIds.length > 0;
    const status = anySignal ? "NOT_FOUND" : "NOT_REFERENCED";
    // 会話に紐づく商品があるなら、それを候補として残す。
    if (params.conversationInventoryId) {
      const linked = await loadOne(params.conversationInventoryId, "この会話に紐づけられている商品");
      if (linked) {
        return {
          status: "RESOLVED",
          resolved: linked,
          candidates: [linked],
          references,
          usedFullScan,
          baseProducts,
          onSaleCategoryResolved,
          inventorySyncSuspected: false,
          zaicoLastSyncedAt: null,
        };
      }
    }
    return {
      status,
      resolved: null,
      candidates: [],
      references,
      usedFullScan,
      baseProducts,
      onSaleCategoryResolved,
      inventorySyncSuspected: false,
      zaicoLastSyncedAt: (await getZaicoSyncFreshness()).lastSyncedAt,
    };
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
  let resolution = decideResolution(mergeSameProduct(scored));
  let inventorySyncSuspected = false;
  const freshness = await getZaicoSyncFreshness();

  // ── ZAICO同期の未反映を疑うフォールバック(2026-09-03 利用者指示) ──
  //
  // 「販売中カテゴリに存在しない → 対象外」と即断しない。BELLOの在庫
  // カテゴリはZAICO同期で入るため、BASEの出品状態より遅れることがある。
  // 実測(2026-09-03)でも、BASEで出品中の BoConcept Elba の在庫は
  // 「五十嵐さん」「複数在庫 未出品」にあり、販売中には1件も無かった。
  //
  // ただし発送完了まで無差別に拾うと誤特定になる。**採用条件を
  // 「BASE商品ページの商品名と一致した候補」に限る** —— 顧客が送ってきた
  // URLからIDで確定的に引いたタイトルとの一致なので、ブランド名や語の
  // 断片の積み上げとは信頼度が違う(scoring.ts の officialTitles 参照)。
  const hasOfficialTitleSignal = (signals.officialTitles?.length ?? 0) > 0;

  /** 広げた範囲を出品タイトルの一致だけで採る。語の断片で拾った過去在庫は採らない。 */
  const rescoreByOfficialTitle = (wider: MatchableInventory[]): ProductMatch[] =>
    wider
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
      .filter((m) => m.reasons.some((r) => r.startsWith(OFFICIAL_TITLE_MATCH_PREFIX)));

  if (resolution.candidates.length === 0 && usedFullScan && hasOfficialTitleSignal && baseProducts.length > 0) {
    const rescored = rescoreByOfficialTitle(await loadSyncLagFallbackForNameScan());
    if (rescored.length > 0) {
      const widened = decideResolution(mergeSameProduct(rescored));
      if (widened.candidates.length > 0) {
        resolution = widened;
        inventorySyncSuspected = true;
      }
    }
  }

  // ── 購入済み注文の照合(2026-09-04 追加指示 §50/§65) ──────────────
  //
  // 取引メッセージ・購入通知は**既に売れた商品**の話なので、その在庫は
  // 「販売中」から外れている。上の販売中スキャンは原理的に当たらない
  // (実測: order_2JW2rNd9i7WdFrivCjhfpw の在庫 B005614 は「発送完了」)。
  //
  // 販売中の結果を捨てるのではなく、**より確かなほうを採る**。販売中に
  // 出品タイトルと確実に一致する在庫があるなら(同じ商品を再出品した等)
  // そちらのほうが自然なので、確信度で比べて高いほうを残す。
  if (orderScopePending && rows.length === 0) {
    const rescored = rescoreByOfficialTitle(await loadOrderScopeForNameScan());
    if (rescored.length > 0) {
      const widened = decideResolution(mergeSameProduct(rescored));
      const currentTop = resolution.candidates[0]?.confidence ?? 0;
      const widenedTop = widened.candidates[0]?.confidence ?? 0;
      if (widened.candidates.length > 0 && widenedTop >= currentTop) {
        resolution = widened;
        usedFullScan = true;
      }
    }
  }

  // 候補が1件も残らず、会話に紐づく商品があるならそれを使う。
  if (resolution.candidates.length === 0 && params.conversationInventoryId) {
    const linked = await loadOne(params.conversationInventoryId, "この会話に紐づけられている商品");
    if (linked) {
      return {
        status: "RESOLVED",
        resolved: linked,
        candidates: [linked],
        references,
        usedFullScan,
        baseProducts,
        onSaleCategoryResolved,
        inventorySyncSuspected,
        zaicoLastSyncedAt: freshness.lastSyncedAt,
      };
    }
  }
  return {
    ...resolution,
    references,
    usedFullScan,
    baseProducts,
    onSaleCategoryResolved,
    inventorySyncSuspected,
    zaicoLastSyncedAt: freshness.lastSyncedAt,
  };
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

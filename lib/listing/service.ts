import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { listEcEligibleInventory } from "@/lib/inventory/ecEligibleQuery";
import { resolveTopImage, splitImagesByType } from "@/lib/inventory/imageTypes";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { createMercariProduct } from "./mercari/adapter";
import { createBaseProduct } from "./base/adapter";
import { isEcListingEligible, buildCategoryNameLookup, ecListingIneligibleReason, type CategoryNameLookup } from "./ecEligibility";
import { isE2EFixtureModeActive } from "@/lib/inventory/e2eFixtures";
import { e2eListingsOverviewFetch } from "./e2eFixtures";
import { unwrapList, unwrapWriteRequired } from "@/lib/amplify/listAll";
import { attachStageTimings, currentQueryTimings, groupTimingsByOp, isQueryTimingEnabled, measureStage, withQueryTiming } from "@/lib/perf/queryTiming";
import {
  BASE_ROUTE,
  MERCARI_ROUTE,
  assertNotAlreadyListed,
  describePublishFailure,
  failedPatch,
  publishedPatch,
  publishingPatch,
  requireChannelListing,
  requireDraft,
  saveFailureMessage,
  type PublishRoute,
} from "./publishFlow";
import type {
  ChannelListingRecord,
  ListingChannel,
  ListingConditionCode,
  ListingDraftRecord,
  ListingImageRef,
  ListingShippingMethod,
  ShippingPayerCode,
} from "./types";
import { DEFAULT_LISTING_SHIPPING_METHOD, parseListingShippingMethod } from "./types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §12: 「これは単なるfrontend
 * filterではない」— initial fetch/search/bulk/direct route/server
 * action/API mutationのすべてでisEcListingEligibleを通す。Categoryは
 * 小規模なマスタ(masterSeed.tsのCATEGORY_SEED参照、多くても数十件)
 * なので、書き込み系の各関数(1回の呼び出しにつき1回)がこのヘルパーで
 * 都度取得しても実害は無い — bulkCreateListingDraftsだけはループの
 * 外で1回だけ呼ぶ(ループ内で毎回呼ぶ全件スキャンの重複を避けるため)。
 */
async function loadCategoryNameLookup(): Promise<CategoryNameLookup> {
  const categories = await listAllMasterEntries("Category");
  return buildCategoryNameLookup(categories);
}

/**
 * BELLO統合改修 master指示書 Phase D — EC Listing / Mercari Shops連携の
 * 唯一の読み書き窓口。ListingDraft/ChannelListingへの書き込みは必ず
 * この1ファイルを通る(app/actions/listing.tsのServer Actionsも、
 * このファイルの関数を呼ぶだけ)。
 *
 * READ ONLY境界(spec: 「Listingの変更はZAICO/Inventory Masterを一切
 * 変更しない」): このファイルはgetInventoryDetail(読み取り専用の
 * クエリ)以外、Inventoryモデルを一度も書き込まない —
 * serverDataClient.models.Inventory.create/update/deleteの呼び出しが
 * このファイルに一つも無いことが、その境界がコード上守られている
 * ことの直接の証拠。lib/inventory以下の既存の書き込み経路
 * (app/actions/inventory.ts)とは完全に独立している。
 */

/**
 * ListingDraft.images / ChannelListing.categoryMappingは`a.json()`
 * (AWSJSON)フィールド — lib/inventory/customFieldsCodec.tsで既に文書化
 * されている「wire quirk」(書き込みは実際のJSON文字列でなければならず、
 * 生のJSオブジェクトを渡すと`Variable '...' has an invalid value.`で
 * 失敗する)と同じものがこちらにも当てはまる。読み取り側は文字列
 * (常にこちらが書き込む形)と、既にパース済みのオブジェクト(一部の
 * 読み取り経路で観測される形)の両方を許容する — parseCustomFieldsと
 * 同じ考え方。customFieldsCodec.tsから直接importしないのは、あちらが
 * `Record<string, unknown>`という固定形に型付けされているため
 * (ListingDraft.images/ChannelListing.categoryMappingは配列/別の
 * オブジェクト形なので、同じ関数を使い回すと型があわない)。
 */
function stringifyListingJson(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return JSON.stringify(value);
}

function tolerantParseJson<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      console.error("[lib/listing/service.ts] failed to JSON.parse a stored a.json() value:", raw, err);
      return null;
    }
  }
  return raw as T;
}

function toListingDraftRecord(row: {
  id: string;
  inventoryId: string;
  title: string;
  description?: string | null;
  price?: number | null;
  condition?: ListingConditionCode | null;
  shippingMethod?: string | null;
  images?: unknown;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}): ListingDraftRecord {
  const images = tolerantParseJson<ListingImageRef[]>(row.images) ?? [];
  return {
    id: row.id,
    inventoryId: row.inventoryId,
    title: row.title,
    description: row.description ?? null,
    price: row.price ?? null,
    condition: row.condition ?? null,
    // 未設定(この項目より前に作られた下書き)は既定値として読む。
    // マイグレーションを不要にするための片側の約束。
    shippingMethod: parseListingShippingMethod(row.shippingMethod),
    images,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChannelListingRecord(row: {
  id: string;
  listingDraftId: string;
  inventoryId: string;
  channel: ListingChannel;
  categoryMapping?: unknown;
  overrideTitle?: string | null;
  overrideDescription?: string | null;
  overridePrice?: number | null;
  status: ChannelListingRecord["status"];
  externalListingId?: string | null;
  listingUrl?: string | null;
  firstListedAt?: string | null;
  lastListedAt?: string | null;
  lastRelistedAt?: string | null;
  endedAt?: string | null;
  soldAt?: string | null;
  lastError?: string | null;
  autoPricingEnabled?: boolean | null;
  pricingRuleId?: string | null;
  originalPrice?: number | null;
  currentPrice?: number | null;
  floorPrice?: number | null;
  markdownCount?: number | null;
  lastPriceChangeAt?: string | null;
  nextPriceActionAt?: string | null;
  automationHold?: boolean | null;
  lastAutomationResult?: string | null;
  shippingRank?: ChannelListingRecord["shippingRank"];
  shippingDestinationPrefecture?: string | null;
  calculatedShippingFee?: number | null;
  confirmedShippingFee?: number | null;
  shippingFeeUpdatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}): ChannelListingRecord {
  const categoryMapping = tolerantParseJson<ChannelListingRecord["categoryMapping"]>(row.categoryMapping);
  return {
    id: row.id,
    listingDraftId: row.listingDraftId,
    inventoryId: row.inventoryId,
    channel: row.channel,
    categoryMapping,
    overrideTitle: row.overrideTitle ?? null,
    overrideDescription: row.overrideDescription ?? null,
    overridePrice: row.overridePrice ?? null,
    status: row.status,
    externalListingId: row.externalListingId ?? null,
    listingUrl: row.listingUrl ?? null,
    firstListedAt: row.firstListedAt ?? null,
    lastListedAt: row.lastListedAt ?? null,
    lastRelistedAt: row.lastRelistedAt ?? null,
    endedAt: row.endedAt ?? null,
    soldAt: row.soldAt ?? null,
    lastError: row.lastError ?? null,
    autoPricingEnabled: row.autoPricingEnabled ?? false,
    pricingRuleId: row.pricingRuleId ?? null,
    originalPrice: row.originalPrice ?? null,
    currentPrice: row.currentPrice ?? null,
    floorPrice: row.floorPrice ?? null,
    markdownCount: row.markdownCount ?? 0,
    lastPriceChangeAt: row.lastPriceChangeAt ?? null,
    nextPriceActionAt: row.nextPriceActionAt ?? null,
    automationHold: row.automationHold ?? false,
    lastAutomationResult: row.lastAutomationResult ?? null,
    shippingRank: row.shippingRank ?? null,
    shippingDestinationPrefecture: row.shippingDestinationPrefecture ?? null,
    calculatedShippingFee: row.calculatedShippingFee ?? null,
    confirmedShippingFee: row.confirmedShippingFee ?? null,
    shippingFeeUpdatedAt: row.shippingFeeUpdatedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * inventoryIdに紐づくListingDraftを1件だけ返す(存在しなければnull) —
 * DynamoDBに複合ユニーク制約は無いため、「1つのInventoryにつき最大1件」
 * は呼び出し側(このファイル)がlist+filterで確認して守る(ZAICO同期の
 * sourceInventoryId重複防止と同じ考え方)。
 *
 * 第五ラウンド§6(P0-B) GSI/Scan監査: 以前は`.list({filter})`——
 * ListingDraftテーブル全体に対するDynamoDB Scan——だった。schemaには
 * `secondaryIndexes(index("inventoryId"))`が既に宣言済みで
 * (synth出力のmodel-schema.graphqlで実測確認: queryField名
 * `listListingDraftByInventoryId`)、この呼び出しは商品詳細/EC出品
 * 画面を開くたび=高頻度に発生するため、真のDynamoDB Query(該当
 * inventoryIdの行だけを読む、通常0〜1件)に切り替える。
 */
export async function getListingDraftForInventory(inventoryId: string): Promise<ListingDraftRecord | null> {
  // 第六ラウンドP0-1: E2E fixtureモードでは常に「下書きなし」——
  // lib/inventory/e2eFixtures.tsと同じ二重ゲート(NODE_ENV!=='production'
  // かつ明示的opt-in環境変数)、読み取り専用。
  if (isE2EFixtureModeActive()) return null;
  // 取得に失敗して0件が返ると「下書きは無い」と表示され、そこから
  // 保存すると2件目の下書きができる。失敗は0件ではない。
  const data = unwrapList(
    await serverDataClient.models.ListingDraft.listListingDraftByInventoryId({ inventoryId }, { ...inventoryAuthMode }),
    "出品下書き",
  );
  const found = data.find((d) => !d.deletedAt);
  return found ? toListingDraftRecord(found) : null;
}

/**
 * 第五ラウンド§6(P0-B): ChannelListingは`inventoryId`用と
 * `listingDraftId`用、2本の独立したsecondaryIndexes(複合indexではない)
 * が宣言されている。`channel`はindex化されていないため、
 * `listChannelListingByInventoryId`で該当商品のChannelListing行
 * (実運用ではチャネル数=最大数件)だけを真のQueryで取得し、`channel`
 * 一致判定はその小さな結果集合に対しアプリ側で行う——テーブル全体への
 * Scanを避けつつ、宣言されていない複合キーを偽装しない。
 */
export async function getChannelListing(inventoryId: string, channel: ListingChannel): Promise<ChannelListingRecord | null> {
  if (isE2EFixtureModeActive()) return null; // 第六ラウンドP0-1、getListingDraftForInventoryと同じ安全ゲート
  const data = unwrapList(
    await serverDataClient.models.ChannelListing.listChannelListingByInventoryId({ inventoryId }, { ...inventoryAuthMode }),
    "チャネル出品",
  );
  const found = data.find((d) => d.channel === channel);
  return found ? toChannelListingRecord(found) : null;
}

/** lib/inventory/queries.tsのSEARCH_MAX_SCAN_ITEMSと同じ上限 — Inventory自体がその上限を超えない前提なので、Inventoryとjoinするこちらの一括取得も同じ規模で揃えておく。 */
/** ChannelListingを辿る上限(こちらは在庫と違い件数が小さい)。 */
const LISTING_OVERVIEW_MAX_ITEMS = 20000;

/**
 * EC出品 遅延・画面エラー P1 優先修正(2026-09-13、task_182d944b8cc803a5af
 * 由来 — 一覧の変更点のうちこのlimitだけを継承。個別編集画面
 * ([id]/listing/page.tsx)側の差分はレビュー対象外のため引き継がない):
 * ChannelListing/ListingDraftはどちらも`channel`/`deletedAt`用のGSIを
 * 持たない(secondaryIndexesはinventoryId/listingDraftIdのみ、
 * amplify/data/resource.ts参照)ため、この一覧の初期取得は今後も
 * DynamoDB Scanのまま——これ自体はlistEcEligibleInventoryのようにGSI
 * へ切り替えて解消できる種類の問題ではない。
 *
 * ただし往復回数は減らせる。件数が多いテーブルのScanで往復回数を
 * 減らす効果は、lib/inventory/queries.tsのInventory全件走査で既に実測
 * 済み(5,313件に対しlimit 200→27往復、limit 1000→7往復 —
 * DynamoDBの1ページ1MB上限に先に当たるため、実際の総件数によらず
 * ここが実質的な下限)。この一覧のScanもページごとの`await`が直列に
 * 積み上がる構造は同じなので、同じ理由でlimitを200→1000へ揃える。
 * データ・フィルタ条件・上限(LISTING_OVERVIEW_MAX_ITEMS)は変えていない
 * ——1ページで運べる件数を増やすだけ。
 */
const LISTING_OVERVIEW_PAGE_SIZE = 1000;

async function fetchAllChannelListings(channel: ListingChannel): Promise<ChannelListingRecord[]> {
  const items: ChannelListingRecord[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.ChannelListing.list({
      filter: { channel: { eq: channel } },
      limit: LISTING_OVERVIEW_PAGE_SIZE,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    if (errors) throw new Error(`出品状況の取得に失敗しました: ${JSON.stringify(errors)}`);
    items.push(...data.map(toChannelListingRecord));
    nextToken = nt;
    if (items.length >= LISTING_OVERVIEW_MAX_ITEMS) break;
  } while (nextToken);
  return items;
}

/**
 * EC一覧の「下書きの有無」(ListingOverviewRow.hasDraft)だけを求めるための
 * 軽量版取得(2026-09-13 EC一覧の読取量削減)。
 *
 * ## なぜ全文/画像を運んでいたのが無駄だったか
 *
 * 以前は`fetchAllListingDrafts`が(下書き編集画面と同じ)ListingDraftの
 * 全列——タイトル・説明文・価格・配送方法・images(a.json())・
 * createdBy/updatedBy等——を取得し`ListingDraftRecord`へ変換していたが、
 * この一覧(buildOverviewRows)が実際に使うのは`inventoryId`の集合
 * (`hasDraft: draftInventoryIds.has(item.id)`)だけだった。
 *
 * AppSyncの`selectionSet`でAppSyncが**返す**列を`inventoryId`だけに絞る
 * ——lib/inventory/searchScanProjection.tsのコメントにある通り、DynamoDB
 * →AppSync間の転送自体は減らない(そちらを減らすには
 * ProjectionExpressionでDynamoDBへ直結する必要がある、この一覧は
 * ChannelListing/ListingDraftのGSI自体が未整備のためScanのまま——
 * lib/listing/service.tsのLISTING_OVERVIEW_PAGE_SIZE付近のコメント参照)
 * が、AppSyncが組み立てて返すJSON(images等の大きめのAWSJSON文字列を
 * 含む)自体は小さくなる。`toListingDraftRecord`は使わない——あちらは
 * `id`/`title`/`createdAt`/`updatedAt`等、selectionSetを絞った結果には
 * 無いフィールドを要求する型なので、ここでは呼ばない(無理に使い回すと
 * 型が合わない)。
 *
 * 削除filter(`deletedAt: { attributeExists: false }`)・全ページ追跡・
 * 上限(LISTING_OVERVIEW_MAX_ITEMS)・エラー伝播は`fetchAllListingDrafts`
 * と同じまま——変えたのは選択する列だけ。
 */
async function fetchListingDraftInventoryIds(): Promise<Set<string>> {
  const inventoryIds = new Set<string>();
  let fetchedCount = 0;
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.ListingDraft.list({
      filter: { deletedAt: { attributeExists: false } },
      limit: LISTING_OVERVIEW_PAGE_SIZE,
      nextToken: nextToken ?? undefined,
      selectionSet: ["inventoryId"],
      ...inventoryAuthMode,
    });
    if (errors) throw new Error(`出品下書き一覧の取得に失敗しました: ${JSON.stringify(errors)}`);
    for (const row of data) inventoryIds.add(row.inventoryId);
    // 件数の上限判定は(重複除去前の)取得件数そのもので行う——
    // fetchAllListingDraftsと同じ歯止めの意味を保つ(Setのサイズだと、
    // inventoryIdの重複がもしあった場合に上限判定がずれてしまう)。
    fetchedCount += data.length;
    nextToken = nt;
    if (fetchedCount >= LISTING_OVERVIEW_MAX_ITEMS) break;
  } while (nextToken);
  return inventoryIds;
}

/** 一覧ベースのEC出品管理画面(下記ListingOverviewRow)の1行。 */
export interface ListingOverviewRow {
  inventoryId: string;
  displayId: string;
  name: string;
  quantity: number;
  price: number | null;
  thumbnailKey: string | null;
  inventoryUpdatedAt: string;
  hasDraft: boolean;
  /** 現時点でチャネルはMERCARI_SHOPSのみ(lib/listing/types.tsのListingChannel参照) — 将来チャネルが増えたらこの1フィールドを配列にする。 */
  channelListing: ChannelListingRecord | null;
}

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §15/§16: 在庫一覧
 * ベースのEC出品管理画面(item-centric)向けの一括取得。「eコンビニ」の
 * ような他社の出品管理ツールは、あくまでUI設計の"コンセプト"
 * (商品中心・一括操作・外部ID/状態の可視化・詳細への深いリンク)だけの
 * 参考であり、UI/デザイン/コードは一切参照・コピーしていない。
 *
 * Inventory本体(全件、既存のlistInventoryを再利用)へChannelListing
 * (MERCARI_SHOPS)の有無を突き合わせる — 一度も出品したことがない商品
 * も含めて全件を返すのが意図(spec: 一覧から出品前の商品も見えて選べる
 * 必要がある)。ChannelListing/ListingDraftはInventoryと同じ規模
 * (1 Inventoryにつき最大各1件)なので、lib/inventory/queries.tsの
 * fetchAllInventoryRecordsと同じ「まとめて全件取得してメモリ上でjoin
 * する」方式で十分 — 専用の検索基盤が要るほどの規模ではない。
 */
/**
 * EC出品一覧。
 *
 * ## 2026-09-02: 開くたびに在庫を全件読んでいた
 *
 * 以前は `listInventory({}, { offset: 0, limit: 20000 })` を呼んでいた。
 * その中身は在庫テーブルの**全件スキャン**で、実測すると
 *
 *   全件スキャン(5,313件・7往復) …… 9,246ms
 *   GSIで50件だけ取得(1往復)     ……   173ms   ← 53倍の差
 *
 * だった。画面が表示するのは先頭の数十件なのに、毎回9秒ぶんの読み取りを
 * していたことになる。在庫一覧(/inventory)では既にGSI経路へ切り替えて
 * あったのに、この画面だけ古い経路のまま残っていた。
 *
 * ## 対象外カテゴリの除外と両立させる
 *
 * この一覧はEC出品対象外のカテゴリを落としてから表示する。ページごとに
 * 取ってから落とすと、1ページの件数が減って穴が空く。そこで
 * **必要件数より多めに取ってから絞る**。取りすぎないよう上限を置き、
 * それでも足りなければ「次へ」で続きを取る。
 */
/**
 * Promise.allで束ねる並列読み取りから、最終行を組み立てる純粋な部分。
 * 計測の有無に関わらず同じ関数を通す(二重実装を避ける)。
 *
 * `draftInventoryIds`はfetchListingDraftInventoryIdsが返す「下書きが
 * 存在するinventoryIdの集合」——2026-09-13 EC一覧の読取量削減で
 * `ListingDraftRecord[]`から変更(この関数が使うのは元々inventoryIdの
 * 存在判定だけだったため、呼び出し側の取得を軽量化した分だけ型も
 * それに合わせた)。
 */
function buildOverviewRows(
  inventoryPage: Awaited<ReturnType<typeof listEcEligibleInventory>>,
  channelListings: ChannelListingRecord[],
  draftInventoryIds: Set<string>,
  categoryNameOf: CategoryNameLookup,
): ListingOverviewRow[] {
  const channelListingByInventoryId = new Map(channelListings.map((c) => [c.inventoryId, c]));

  // §12: 「initial fetch」の時点で対象外カテゴリーを除外する — 一覧
  // にすら現れなければ、検索・絞り込み・ページングのどの経路からも
  // 復活しようがない(§94「search: 復活しない」)。
  return inventoryPage.items
    // listEcEligibleInventory が対象カテゴリだけを引いているので、ここは
    // 二重の網。カテゴリ名が後から変わった場合にも取りこぼさない。
    .filter((item) => isEcListingEligible(categoryNameOf(item.categoryId)))
    .map((item) => ({
      inventoryId: item.id,
      displayId: item.displayId,
      name: item.name,
      quantity: item.quantity,
      price: item.salePrice ?? item.plannedSalePrice ?? null,
      thumbnailKey: item.mainImageThumbnailKey ?? item.mainImageStorageKey,
      inventoryUpdatedAt: item.updatedAt,
      hasDraft: draftInventoryIds.has(item.id),
      channelListing: channelListingByInventoryId.get(item.id) ?? null,
    }));
}

/**
 * 計測なしの通常経路(既定)。従来の`listListingsOverview`本体そのまま —
 * 計測が無効なときはこの関数だけが呼ばれ、余計なPromiseラップは一切増えない。
 *
 * 2026-09-13 EC一覧の読取量削減: Category取得を1回だけ行い、
 * `listEcEligibleInventory`(対象カテゴリのGSI抽出)と
 * `buildCategoryNameLookup`(対象外カテゴリー名の解決)の両方へ同じ
 * 結果を渡す——以前はこの2箇所がそれぞれ`listAllMasterEntries
 * ("Category")`を呼んでいて、1回の一覧表示でCategoryマスタを2回
 * 取得していた。`categoriesPromise`を他の独立readと同じ
 * `Promise.all`に含めて即座に発火させたまま、`listEcEligibleInventory`
 * 側はそのPromiseを`await`してから対象カテゴリごとのGSI読み取りへ進む
 * ——Category読み取り自体はChannelListing/ListingDraftの取得と並列に
 * 進み、GSI読み取りだけがCategory解決後に続く(カテゴリIDが無いと
 * GSIを引けないため、そこは元から避けられない依存関係)。
 */
async function fetchListingsOverviewRows(): Promise<ListingOverviewRow[]> {
  const categoriesPromise = listAllMasterEntries("Category");
  const [inventoryPage, channelListings, draftInventoryIds, categories] = await Promise.all([
    // 対象カテゴリだけをGSIから引く(全件スキャンしない)。
    categoriesPromise.then((categories) => listEcEligibleInventory(categories)),
    fetchAllChannelListings("MERCARI_SHOPS"),
    fetchListingDraftInventoryIds(),
    categoriesPromise,
  ]);
  return buildOverviewRows(inventoryPage, channelListings, draftInventoryIds, buildCategoryNameLookup(categories));
}

/** 一覧の計測結果 1段階ぶん。固定ラベル・壁時計経過時間・成否のみ ── 商品・顧客・認証情報は一切含まない。 */
export interface ListingsOverviewStageTiming {
  stage: string;
  /** その段階(=1本の並列読み取り)自体の壁時計経過時間(ms)。 */
  elapsedMs: number;
  ok: boolean;
}

/** model.opごとの累積往復回数/所要ms(参考値 ── 並列実行された分はそのまま加算されるため、上のelapsedMsのような壁時計の待ち時間ではない。lib/perf/queryTiming.tsのgroupTimingsByOp参照)。 */
export interface ListingsOverviewQueryTotal {
  key: string;
  pages: number;
  ms: number;
  ok: boolean;
}

export interface ListingsOverviewTimedResult {
  rows: ListingOverviewRow[];
  /** 4本の並列読み取りそれぞれの壁時計経過時間。計測無効(既定)時、またはE2E fixtureモード時は常に空配列。 */
  stages: ListingsOverviewStageTiming[];
  /** 参考値(上記コメント参照)。計測無効時は空配列。 */
  queryTotals: ListingsOverviewQueryTotal[];
  totalMs: number;
}

/**
 * 4本の並列読み取りを、個別に壁時計で計測しながら実行する
 * (2026-09-13 EC計測レビュー補正)。
 *
 * `measureStage`はどれか1本が失敗しても投げ直さない(lib/perf/
 * queryTiming.tsのコメント参照)ため、4本とも必ず`Promise.all`で
 * 揃うまで待つ ── 途中の1本が速く失敗しても、他の段階の計測が
 * 欠けたまま終わることはない。全て成功していれば通常どおり行を組み立てて
 * 返し、1本でも失敗していれば、最初に失敗した段階の元の例外へ4本ぶんの
 * 計測結果を添えて投げる(一覧の「失敗したら例外を投げる」契約自体は
 * そのまま)。
 *
 * ## 2026-09-13 EC一覧の読取量削減: 段階定義の補正(二重計上回避)
 *
 * `categoryNames`段階は、以前は`loadCategoryNameLookup`(Category取得+
 * ルックアップ関数の構築)を計測していたが、今は`listAllMasterEntries
 * ("Category")`の取得そのものだけを計測する(ルックアップの構築は
 * 全件成功後にO(件数)の同期処理として1回だけ行う——計測対象にするほどの
 * 重さではない)。
 *
 * `ecEligibleInventory`段階は、以前は自分自身の中で独立に
 * `listAllMasterEntries("Category")`を呼んでいた(=`categoryNames`段階と
 * 合わせて実質2回のCategory取得を別々に計測していた)。今は
 * `categoryNames`段階と同じ1個のPromise(`categoryOutcomePromise`)を
 * 待ってから対象カテゴリごとのGSI読み取りへ進む——Category取得の待ち
 * 時間は`categoryNames`段階の壁時計として1回だけ数えられ、
 * `ecEligibleInventory`段階にはそのGSI読み取り自体の待ち時間が主に乗る
 * (Category解決を待つ分だけ多少上乗せされ得るが、`Promise.all`内で
 * 全段階が同時に発火するため、その上乗せは通常ごく小さい)。総readの
 * 回数・件数への影響は無い——変わるのは壁時計の内訳だけ。
 */
async function fetchListingsOverviewRowsTimed(): Promise<{ rows: ListingOverviewRow[]; stages: ListingsOverviewStageTiming[] }> {
  const categoryOutcomePromise = measureStage("categoryNames", () => listAllMasterEntries("Category"));
  const [inventoryOutcome, channelOutcome, draftOutcome, categoryOutcome] = await Promise.all([
    measureStage("ecEligibleInventory", async () => {
      const catOutcome = await categoryOutcomePromise;
      // categoryNames段階が失敗していれば、この段階もそれ以上進めない
      // ——GSI読み取りにはカテゴリIDが要るため(同じ失敗が2段階に記録
      // されるのは二重計上ではなく、両方が実際に失敗したという事実)。
      if (!catOutcome.ok) throw catOutcome.error;
      return listEcEligibleInventory(catOutcome.value);
    }),
    measureStage("channelListings", () => fetchAllChannelListings("MERCARI_SHOPS")),
    measureStage("listingDrafts", fetchListingDraftInventoryIds),
    categoryOutcomePromise,
  ]);
  const outcomes = [inventoryOutcome, channelOutcome, draftOutcome, categoryOutcome];
  const stages = outcomes.map((o) => o.timing);

  const firstFailure = outcomes.find((o): o is { ok: false; error: unknown; timing: ListingsOverviewStageTiming } => !o.ok);
  if (firstFailure) throw attachStageTimings(firstFailure.error, stages);

  // 全て成功 ── ここでは各outcomeがok:trueであることが上のチェックで保証済み。
  const rows = buildOverviewRows(
    (inventoryOutcome as { ok: true; value: Awaited<ReturnType<typeof listEcEligibleInventory>> }).value,
    (channelOutcome as { ok: true; value: ChannelListingRecord[] }).value,
    (draftOutcome as { ok: true; value: Set<string> }).value,
    buildCategoryNameLookup((categoryOutcome as { ok: true; value: Awaited<ReturnType<typeof listAllMasterEntries>> }).value),
  );
  return { rows, stages };
}

/**
 * `listListingsOverview`と同じ処理を、段階別の壁時計経過時間・
 * model.op別の累積参考値つきで返す(2026-09-13 EC計測レビュー補正)。
 *
 * `listListingsOverview`はこの関数の`rows`をそのまま返すだけの薄い
 * ラッパー(二重実装ではない)── 計測の有無でデータの取り方・件数・
 * 順序が変わることは無い。
 */
export async function listListingsOverviewWithTiming(): Promise<ListingsOverviewTimedResult> {
  // lib/listing/service.tsのgetListingDraftForInventory等と同じ二重
  // ゲート(isE2EFixtureModeActive)── listListingsOverviewWithTimingを
  // 診断エンドポイントから直接呼ぶ経路でも、E2E fixtureモードでは実AWS
  // へ触れない。
  if (isE2EFixtureModeActive()) {
    return { rows: await e2eListingsOverviewFetch(), stages: [], queryTotals: [], totalMs: 0 };
  }

  const startedAt = performance.now();
  if (!isQueryTimingEnabled()) {
    const rows = await fetchListingsOverviewRows();
    return { rows, stages: [], queryTotals: [], totalMs: Math.round(performance.now() - startedAt) };
  }

  return withQueryTiming("listings-overview", async () => {
    const { rows, stages } = await fetchListingsOverviewRowsTimed();
    const queryTotals: ListingsOverviewQueryTotal[] = groupTimingsByOp(currentQueryTimings()).map((g) => ({
      key: g.key,
      pages: g.count,
      ms: Math.round(g.ms),
      ok: g.ok,
    }));
    return { rows, stages, queryTotals, totalMs: Math.round(performance.now() - startedAt) };
  });
}

/**
 * EC出品一覧。
 *
 * ## 2026-09-02: 開くたびに在庫を全件読んでいた
 *
 * 以前は `listInventory({}, { offset: 0, limit: 20000 })` を呼んでいた。
 * その中身は在庫テーブルの**全件スキャン**で、実測すると
 *
 *   全件スキャン(5,313件・7往復) …… 9,246ms
 *   GSIで50件だけ取得(1往復)     ……   173ms   ← 53倍の差
 *
 * だった。画面が表示するのは先頭の数十件なのに、毎回9秒ぶんの読み取りを
 * していたことになる。在庫一覧(/inventory)では既にGSI経路へ切り替えて
 * あったのに、この画面だけ古い経路のまま残っていた。
 *
 * ## 対象外カテゴリの除外と両立させる
 *
 * この一覧はEC出品対象外のカテゴリを落としてから表示する。ページごとに
 * 取ってから落とすと、1ページの件数が減って穴が空く。そこで
 * **必要件数より多めに取ってから絞る**。取りすぎないよう上限を置き、
 * それでも足りなければ「次へ」で続きを取る。
 */
export async function listListingsOverview(): Promise<ListingOverviewRow[]> {
  // EC一覧P1 レビュー補正(2026-09-13): Playwright E2E専用(二重ゲート
  // 済み — lib/listing/e2eFixtures.tsのコメント参照)。実AWSに到達
  // できないsandboxで364件描画・5秒遅延・read rejection復帰を実ブラウザ
  // 検証するための分岐で、本番/実データ経路には一切影響しない。
  if (isE2EFixtureModeActive()) return e2eListingsOverviewFetch();

  const { rows } = await listListingsOverviewWithTiming();
  return rows;
}

/**
 * EC一覧P1 レビュー補正(2026-09-13): 一覧画面(page.tsx→
 * ListingsOverviewData.tsx)専用の局所エラー処理版。
 *
 * app/inventory/(protected)/[id]/InventoryHistoryTable.tsxと同じ設計 —
 * 素朴にlistListingsOverviewを直接呼ぶと、その例外がSuspense境界の
 * 外(ページ全体のerror境界、app/inventory/error.tsx)へ波及し、
 * ヘッダー・検索欄まで巻き込んでエラー画面に差し替わってしまう
 * (在庫一覧のInventoryTotalCount.tsxのコメントにある「Staging実機で
 * 6回に1回、画面全体がエラーになった」と同じ失敗モード)。ここで
 * try/catchして「取得できた行(配列)」か「取得エラー(null)」かに
 * 落とし、実際の表示(空表示との区別・再試行導線)はクライアント側の
 * ListingsOverviewTableに委ねる。
 */
export async function listListingsOverviewSafe(): Promise<ListingOverviewRow[] | null> {
  try {
    return await listListingsOverview();
  } catch (err) {
    // ログは識別情報(商品名等)を出さない — エラー種別のみ。
    console.warn("[lib/listing/service.ts] EC出品一覧の取得に失敗しました(ヘッダー等の表示は継続します)", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/**
 * 一覧画面からの一括下書き作成(spec §16: 「一括操作」)。既に下書きが
 * ある商品は上書きせずスキップする(既存のカスタマイズを壊さないため
 * — saveListingDraftはupsertなので、うっかり全件へ呼ぶとタイトル/価格
 * を初期値へ巻き戻してしまう)。conditionの初期値
 * "NO_NOTABLE_DAMAGE"は、既存の単品編集フォーム
 * (ListingForm.tsxのuseState初期値)が新規下書きに対して使っているのと
 * 同じ既定値 — 出品実行前にADMIN/EDITORが商品詳細のEC出品タブで確認・
 * 変更できる、あくまで編集可能な下書きの初期値であり、
 * lib/listing/mercari/adapter.tsが拒否する「未確認のまま実際にMercari
 * へ送ってしまう」こととは別の話(そちらは出品実行の直前でconditionが
 * nullなら明示的にブロックする、既に対応済みの安全弁)。
 */
export async function bulkCreateListingDrafts(
  inventoryIds: string[],
  who: string | null,
): Promise<{ created: string[]; skipped: string[]; failed: { inventoryId: string; error: string }[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const failed: { inventoryId: string; error: string }[] = [];
  // §12/§94「bulk: 含まれない」— ループの外で1回だけCategoryを取得する
  // (件数分だけ全件スキャンを繰り返さないため)。
  const categoryNameOf = await loadCategoryNameLookup();

  for (const inventoryId of inventoryIds) {
    try {
      const existing = await getListingDraftForInventory(inventoryId);
      if (existing) {
        skipped.push(inventoryId);
        continue;
      }
      const inventory = await getInventoryDetail(inventoryId);
      if (!inventory) {
        failed.push({ inventoryId, error: "対象の在庫が見つかりません。" });
        continue;
      }
      const categoryName = categoryNameOf(inventory.categoryId);
      if (!isEcListingEligible(categoryName)) {
        failed.push({ inventoryId, error: ecListingIneligibleReason(categoryName as string) });
        continue;
      }
      await saveListingDraft(
        inventoryId,
        {
          title: inventory.name,
          description: "",
          price: inventory.salePrice ?? inventory.plannedSalePrice ?? 0,
          condition: "NO_NOTABLE_DAMAGE",
        },
        who,
      );
      created.push(inventoryId);
    } catch (err) {
      failed.push({ inventoryId, error: err instanceof Error ? err.message : "不明なエラー" });
    }
  }

  return { created, skipped, failed };
}

export interface ListingDraftInput {
  title: string;
  description: string;
  price: number;
  condition: ListingConditionCode;
  /** 配送方法(§1)。省略時は既存の下書きの値、それも無ければ既定値。 */
  shippingMethod?: ListingShippingMethod;
}

/**
 * ListingDraftを新規作成または更新する。既存のInventoryをプリフィル
 * する初回作成(呼び出し元がgetInventoryDetail経由で在庫の商品名/価格/
 * 画像を渡す)と、その後のユーザー編集の両方をこの1関数でカバーする
 * (createInventory/updateInventoryを分けているapp/actions/inventory.ts
 * と違い、ListingDraftは「無ければ作る、あれば更新する」upsertの方が
 * 自然 — 在庫と違い、下書きの作成それ自体はユーザーが明示的に意識する
 * 操作ではないため)。
 */
export async function saveListingDraft(
  inventoryId: string,
  input: ListingDraftInput,
  who: string | null,
): Promise<ListingDraftRecord> {
  if (!input.title.trim()) throw new Error("出品タイトルを入力してください。");

  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");

  // §12: 「direct route」「product detail listing action」「server
  // action」全部で対象外カテゴリーをブロックする — 一覧に出ていない
  // 商品でも、詳細画面や直接のServer Action呼び出しから下書きを作れて
  // しまう抜け道を防ぐ。
  const categoryNameOf = await loadCategoryNameLookup();
  const categoryName = categoryNameOf(inventory.categoryId);
  if (!isEcListingEligible(categoryName)) throw new Error(ecListingIneligibleReason(categoryName as string));

  // 出品用画像はInventoryの商品画像(NORMAL)をそのまま参照する — 出品
  // 専用の画像を別途アップロードする機能はPhase Dでは持たない(spec:
  // 「画像」は既存Inventory画像の再利用を前提とした構成)。傷・汚れ写真
  // (DAMAGE)は出品には含めない。
  const { normal } = splitImagesByType(inventory.images);
  const top = resolveTopImage(inventory.images);
  const ordered = top ? [top, ...normal.filter((i) => i !== top)] : normal;
  const images: ListingImageRef[] = ordered.map((img, idx) => ({ storageKey: img.storageKey, sortOrder: idx }));

  const existing = await getListingDraftForInventory(inventoryId);
  const fields = {
    title: input.title.trim(),
    description: input.description.trim() || undefined,
    price: input.price,
    condition: input.condition,
    // §1 未指定なら既存の選択を保つ。保存のたびに既定値へ戻すと、
    // 佐川を選んだ商品がタイトル修正だけで家財便へ戻ってしまう。
    shippingMethod: input.shippingMethod ?? existing?.shippingMethod ?? DEFAULT_LISTING_SHIPPING_METHOD,
    images: stringifyListingJson(images),
    updatedBy: who ?? undefined,
  };

  if (existing) {
    const { data: updated, errors } = await serverDataClient.models.ListingDraft.update({ id: existing.id, ...fields }, inventoryAuthMode);
    if (errors || !updated) throw new Error(`出品下書きの更新に失敗しました: ${JSON.stringify(errors)}`);
    return toListingDraftRecord(updated);
  }

  const { data: created, errors } = await serverDataClient.models.ListingDraft.create(
    { inventoryId, ...fields, createdBy: who ?? undefined },
    inventoryAuthMode,
  );
  if (errors || !created) throw new Error(`出品下書きの作成に失敗しました: ${JSON.stringify(errors)}`);
  return toListingDraftRecord(created);
}

export interface ChannelOverrideInput {
  categoryMapping: { mercariCategoryId: string; mercariCategoryName?: string } | null;
  overrideTitle: string | null;
  overrideDescription: string | null;
  overridePrice: number | null;
}

/** 指定チャネルのChannelListingを作成(無ければ)または上書き(あれば)する。重複防止: inventoryId+channelで事前に存在確認してから作成する(DynamoDBに複合ユニーク制約が無いための、このアプリ全体で一貫した対処方法)。 */
export async function saveChannelOverride(
  inventoryId: string,
  channel: ListingChannel,
  input: ChannelOverrideInput,
  who: string | null,
): Promise<ChannelListingRecord> {
  const draft = await getListingDraftForInventory(inventoryId);
  if (!draft) throw new Error("先に出品下書き（タイトル・説明文・価格）を保存してください。");

  // §12/§128: カテゴリーはInventory編集画面からいつでも変更されうる
  // ため、下書き作成時点で通っていても、ここでも都度再確認する
  // (「Status Sync」— ローカルの古い前提を信用しない、という考え方を
  // このEC出品対象外判定にも適用)。
  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");
  const categoryNameOf = await loadCategoryNameLookup();
  const categoryName = categoryNameOf(inventory.categoryId);
  if (!isEcListingEligible(categoryName)) throw new Error(ecListingIneligibleReason(categoryName as string));

  const existing = await getChannelListing(inventoryId, channel);
  const fields = {
    categoryMapping: stringifyListingJson(input.categoryMapping),
    overrideTitle: input.overrideTitle?.trim() || undefined,
    overrideDescription: input.overrideDescription?.trim() || undefined,
    overridePrice: input.overridePrice ?? undefined,
    updatedBy: who ?? undefined,
  };

  if (existing) {
    const { data: updated, errors } = await serverDataClient.models.ChannelListing.update({ id: existing.id, ...fields }, inventoryAuthMode);
    if (errors || !updated) throw new Error(`チャネル別設定の更新に失敗しました: ${JSON.stringify(errors)}`);
    return toChannelListingRecord(updated);
  }

  const { data: created, errors } = await serverDataClient.models.ChannelListing.create(
    {
      listingDraftId: draft.id,
      inventoryId,
      channel,
      status: "DRAFT",
      ...fields,
      createdBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (errors || !created) throw new Error(`チャネル別設定の作成に失敗しました: ${JSON.stringify(errors)}`);
  return toChannelListingRecord(created);
}

/**
 * Mercari Shopsへ実際に出品する。冪等性/重複防止(spec要件): 既に
 * ACTIVE(externalListingIdを持つ)状態のChannelListingへ再度出品を
 * 試みることは拒否する。
 *
 * BELLO統合業務OS指示書(2026-08-30) §21: 「自動再出品」自体
 * (旧listing ENDED→新listing作成、または同一IDでの再公開)は、
 * Mercari側のupdateProduct/再出品APIの実仕様がこのsandbox環境から
 * 確認できていない([UNVERIFIED] — lib/listing/mercari/adapter.tsの
 * ファイル冒頭コメント参照)ため今回は実装していない — 実際に呼び出す
 * 手段の無い状態を「実装済み」と称さない(§109/§155)。ACTIVE状態への
 * 再出品を試みた場合、以前と同じくエラーとして明確にブロックする
 * (状態機械上はRELIST_PENDINGを用意済みだが、そこへ遷移させる具体的
 * なトリガーはまだ無い)。
 */
export async function listOnMercari(
  inventoryId: string,
  shippingPayer: ShippingPayerCode,
  who: string | null,
): Promise<ChannelListingRecord> {
  const route: PublishRoute = MERCARI_ROUTE;

  const draft = await getListingDraftForInventory(inventoryId);
  requireDraft(draft);

  const channelListing = await getChannelListing(inventoryId, route.channel);
  requireChannelListing(channelListing, route);
  assertNotAlreadyListed(channelListing, route);

  // BELLO統合改修 master指示書(2026-08-29統合改修版) §17-A: variant
  // 構造のquantityは出品実行の直前に取得した実在庫数量を使う
  // (lib/listing/mercari/adapter.tsのMercariListingInputコメント参照
  // — 下書き保存時点の値をコピーして古くならないよう、ここで都度取得
  // する)。
  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");

  // §12/§128: 出品実行の直前にも再確認する(下書き保存後にカテゴリーが
  // 対象外へ変更された場合、実際の出品APIを叩く前にここで止める)。
  const categoryNameOf = await loadCategoryNameLookup();
  const categoryName = categoryNameOf(inventory.categoryId);
  if (!isEcListingEligible(categoryName)) throw new Error(ecListingIneligibleReason(categoryName as string));

  // §15: PUBLISHING = 外部APIへ呼び出し中(旧QUEUEDから改称 — QUEUEDは
  // §14の新しい語彙では「バッチ/スケジュール待ち」を指すため、この
  // 同期的なcreateProduct呼び出し中の状態にはPUBLISHINGの方が正確)。
  // 外部APIを叩く前に「呼び出し中」を確実に残す。ここが黙って失敗すると、
  // 途中で落ちたときに出品済みかどうかを判断する手がかりが無くなる。
  unwrapWriteRequired(
    await serverDataClient.models.ChannelListing.update(publishingPatch(channelListing.id, who), inventoryAuthMode),
    "出品状態(呼び出し中)",
  );

  try {
    const result = await createMercariProduct({ draft, channelListing, shippingPayer, inventoryQuantity: inventory.quantity });
    const { data: updated, errors } = await serverDataClient.models.ChannelListing.update(
      publishedPatch({ channelListing, result, route, who, nowIso: new Date().toISOString() }),
      inventoryAuthMode,
    );
    if (errors || !updated) throw new Error(saveFailureMessage(errors));
    return toChannelListingRecord(updated);
  } catch (err) {
    const { data: failed } = await serverDataClient.models.ChannelListing.update(
      failedPatch(channelListing.id, describePublishFailure(err), who),
      inventoryAuthMode,
    );
    console.error(`[${route.logLabel}] inventoryId=${inventoryId} failed:`, err);
    if (failed) return toChannelListingRecord(failed);
    throw err;
  }
}

/**
 * BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASEへ実際に
 *出品する。listOnMercariと同じ状態遷移パターン(PUBLISHING→ACTIVE/
 * ERROR)だが、BASEの実API(items/add)はMercariと違いカテゴリー
 * マッピング必須ではなく、画像も送らない(lib/listing/base/adapter.ts
 * ファイル冒頭コメント参照 — 画像同期は今回未実装)。
 */
export async function listOnBase(inventoryId: string, who: string | null): Promise<ChannelListingRecord> {
  const route: PublishRoute = BASE_ROUTE;

  const draft = await getListingDraftForInventory(inventoryId);
  requireDraft(draft);

  const channelListing = await getChannelListing(inventoryId, route.channel);
  requireChannelListing(channelListing, route);
  assertNotAlreadyListed(channelListing, route);

  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");

  const categoryNameOf = await loadCategoryNameLookup();
  const categoryName = categoryNameOf(inventory.categoryId);
  if (!isEcListingEligible(categoryName)) throw new Error(ecListingIneligibleReason(categoryName as string));

  // Mercari側と同じ理由。
  unwrapWriteRequired(
    await serverDataClient.models.ChannelListing.update(publishingPatch(channelListing.id, who), inventoryAuthMode),
    "出品状態(呼び出し中)",
  );

  try {
    const result = await createBaseProduct({
      draft,
      overrideTitle: channelListing.overrideTitle,
      overrideDescription: channelListing.overrideDescription,
      overridePrice: channelListing.overridePrice,
      quantity: inventory.quantity,
    });
    const { data: updated, errors } = await serverDataClient.models.ChannelListing.update(
      publishedPatch({ channelListing, result, route, who, nowIso: new Date().toISOString() }),
      inventoryAuthMode,
    );
    if (errors || !updated) throw new Error(saveFailureMessage(errors));
    return toChannelListingRecord(updated);
  } catch (err) {
    const { data: failed } = await serverDataClient.models.ChannelListing.update(
      failedPatch(channelListing.id, describePublishFailure(err), who),
      inventoryAuthMode,
    );
    console.error(`[${route.logLabel}] inventoryId=${inventoryId} failed:`, err);
    if (failed) return toChannelListingRecord(failed);
    throw err;
  }
}

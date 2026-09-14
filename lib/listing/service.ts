import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { listEcEligibleInventory } from "@/lib/inventory/ecEligibleQuery";
import { resolveTopImage, splitImagesByType } from "@/lib/inventory/imageTypes";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { createBaseProduct } from "./base/adapter";
import { isEcListingEligible, buildCategoryNameLookup, ecListingIneligibleReason, type CategoryNameLookup } from "./ecEligibility";
import { isE2EFixtureModeActive } from "@/lib/inventory/e2eFixtures";
import {
  e2eListingsOverviewFetch,
  E2E_MANUAL_ONLY_INVENTORY_ID,
  e2eManualOnlyChannelListing,
  e2eManualOnlyListingDraft,
  e2eMercariCsvListingDraft,
  e2eMercariCsvChannelListingFor,
  e2eChannelOverrideFor,
  e2eSaveChannelOverride,
} from "./e2eFixtures";
import { unwrapList, unwrapWriteRequired } from "@/lib/amplify/listAll";
import { attachStageTimings, currentQueryTimings, getStageTimings, groupTimingsByOp, isQueryTimingEnabled, measureStage, withQueryTiming } from "@/lib/perf/queryTiming";
import {
  classifyListingsOverviewErrorKind,
  firstFailedStage,
  tagListingsOverviewFailureStage,
  taggedFailureStage,
  type ListingsOverviewFailureInfo,
  type ListingsOverviewLoadOutcome,
} from "./overviewFailure";
import {
  BASE_ROUTE,
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
  MercariCategoryMapping,
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
  //
  // 2026-09-14 指示書レビュー修正: 「出品内容をコピー（手動出品用）」
  // ボタンは下書きが無いと描画されない(disabled={!draft}) —— ボタン
  // 自体を実Playwrightでクリック検証するため、専用id(e2e-inv-30)
  // だけは合成の下書きを返す。他のidは従来通りnull(既存specは無変更)。
  if (isE2EFixtureModeActive()) {
    if (inventoryId === E2E_MANUAL_ONLY_INVENTORY_ID) return e2eManualOnlyListingDraft();
    // Mercari CSV画像受渡しE2E(2026-09-14レビュー修正、lib/listing/
    // e2eFixtures.ts参照)——該当しないidはnullのまま(上と同じ関数内)。
    const mercariCsvDraft = e2eMercariCsvListingDraft(inventoryId);
    if (mercariCsvDraft) return mercariCsvDraft;
    return null;
  }
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
  if (isE2EFixtureModeActive()) {
    // 2026-09-14 指示書レビュー修正: AutoPricingSectionはchannelListingが
    // 無いと描画されない({channelListing && (...)}) —— getListingDraft
    // ForInventoryと同じ専用id・同じ理由で合成のChannelListing(MERCARI_
    // SHOPS)を返す。他のid/チャネルは従来通りnull。
    // task_48c715588f96367bc9(2026-09-15): CSV編集補完(saveChannelOverride)
    // の合成保存状態が既にあれば、静的fixtureより優先して返す
    // (e2eChannelOverrideFor——保存されたことが一度も無いidでは常に
    // fallbackがそのまま返るため、既存の分岐の挙動は変えていない)。
    if (inventoryId === E2E_MANUAL_ONLY_INVENTORY_ID && channel === "MERCARI_SHOPS") {
      return e2eChannelOverrideFor(inventoryId, channel, e2eManualOnlyChannelListing());
    }
    // Mercari CSV画像受渡しE2E(2026-09-14レビュー修正)——該当しないidはnull。
    if (channel === "MERCARI_SHOPS") {
      return e2eChannelOverrideFor(inventoryId, channel, e2eMercariCsvChannelListingFor(inventoryId));
    }
    return e2eChannelOverrideFor(inventoryId, channel, null); // 第六ラウンドP0-1、getListingDraftForInventoryと同じ安全ゲート
  }
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
 * 計測なしの通常経路(既定)。最初の取得失敗を速やかに返す、素の
 * `Promise.all`のfail-fast契約(4本のうち1本でも失敗すれば即座に
 * reject する ── 他の3本の決着を待たない)。
 *
 * ## 2026-09-13 補正(task_2c27a70778613453ed): 通常UIを「全部待ち」にしない
 *
 * 先行のEC一覧P1 実失敗分類タスク(task_12046ac60ecd86913c)は、この
 * 既定経路も`fetchListingsOverviewRowsWithStages`(4本とも`measureStage`
 * でok:falseへ潰してから`Promise.all`で待つ設計 ── `measureStage`自体は
 * 失敗を投げ直さないため、実質「4本全部の決着を待ってから最初の失敗を
 * 選ぶ」動きになる、lib/perf/queryTiming.tsのコメント参照)へ一本化して
 * いた。狙いは「既定経路でも失敗段階を特定できるようにする」ことだった
 * が、代償として本番でユーザーが実際に踏む失敗の復帰が遅れる——1本が
 * 数百msで速く失敗しても、他の3本(特にChannelListing/ListingDraftの
 * フルScan)の決着を待つ分だけ、ユーザーへのエラー表示が遅れる。
 * 「4本とも数百ms」は本番実測ではなく見積もりに過ぎず、1本が長時間
 * かかる/ハングする状況ではこの「全部待ち」がそのまま復帰の遅延になる
 * (計測専用ON経路の`fetchListingsOverviewRowsWithStages`は、実際に
 * 4本すべての壁時計を報告する必要があるという別の契約を持つため、
 * そちらは「全部待ち」のままにする ── 下記参照)。
 *
 * 段階の特定(`ListingsOverviewFailureInfo.stage`)自体は失わない ──
 * 各読み取りの`.catch`で、失敗した時点の段階名だけを
 * `tagListingsOverviewFailureStage`(lib/listing/overviewFailure.ts)で
 * 例外へ直接タグ付けする。`measureStage`のように4本ぶんの計測配列を
 * 集めて待つ必要が無いので、fail-fastのまま段階を特定できる。
 *
 * ## categoryNames依存の誤表示を防ぐ
 *
 * `ecEligibleInventory`はcategoryNames取得(`categoriesPromise`)を
 * 待ってから対象カテゴリのGSI読み取りへ進む。categoryNamesが失敗すると
 * `categoriesPromise`自体がrejectし、その伝播を受けた
 * `ecEligibleInventory`側の`.catch`にも同じ例外が来る——
 * `tagListingsOverviewFailureStage`は既にタグが付いていれば上書き
 * しないため、`categoriesPromise`側の`.catch`が先に付けた
 * "categoryNames"タグがそのまま残り、"ecEligibleInventory"で上書き
 * されない(根本原因ではなく依存先の症状を「失敗段階」と誤表示しない)。
 */
async function fetchListingsOverviewRows(): Promise<ListingOverviewRow[]> {
  const categoriesPromise = listAllMasterEntries("Category").catch((err) => {
    throw tagListingsOverviewFailureStage(err, "categoryNames");
  });
  const [inventoryPage, channelListings, draftInventoryIds, categories] = await Promise.all([
    // 対象カテゴリだけをGSIから引く(全件スキャンしない)。
    categoriesPromise
      .then((categories) => listEcEligibleInventory(categories))
      .catch((err) => {
        throw tagListingsOverviewFailureStage(err, "ecEligibleInventory");
      }),
    fetchAllChannelListings("MERCARI_SHOPS").catch((err) => {
      throw tagListingsOverviewFailureStage(err, "channelListings");
    }),
    fetchListingDraftInventoryIds().catch((err) => {
      throw tagListingsOverviewFailureStage(err, "listingDrafts");
    }),
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
 * (2026-09-13 EC計測レビュー補正)。**計測フラグ(`BELLO_QUERY_TIMING=1`)
 * が立っているときの診断専用経路**——既定の通常UIはこの関数を使わない
 * (下記`fetchListingsOverviewRows`のfail-fast版を使う、
 * 2026-09-13 task_2c27a70778613453ed補正 参照)。
 *
 * `measureStage`はどれか1本が失敗しても投げ直さない(lib/perf/
 * queryTiming.tsのコメント参照)ため、4本とも必ず`Promise.all`で
 * 揃うまで待つ ── 途中の1本が速く失敗しても、他の段階の計測が
 * 欠けたまま終わることはない。全て成功していれば通常どおり行を組み立てて
 * 返し、1本でも失敗していれば、最初に失敗した段階の元の例外へ4本ぶんの
 * 計測結果を添えて投げる(一覧の「失敗したら例外を投げる」契約自体は
 * そのまま)。この「4本全部の決着を待つ」動きは計測専用経路だからこそ
 * 許容している契約であり、通常UIへは波及させない。
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
 * 待ってから対象カテゴリごとのGSI読み取りへ進む。
 * `ecEligibleInventory`の壁時計時間にはCategoryの待ち時間も含まれる。
 * 各段階は重なりを持つため、その合計を総待ち時間として扱わない。
 * Categoryの読取要求自体は1回だけであり、総待ち時間はtotalMsで確認する。
 */
async function fetchListingsOverviewRowsWithStages(): Promise<{ rows: ListingOverviewRow[]; stages: ListingsOverviewStageTiming[] }> {
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
 *
 * 2026-09-13 補正(task_2c27a70778613453ed): 計測フラグOFF(既定、
 * 通常UIが通る経路)では`fetchListingsOverviewRows`(fail-fast、
 * 段階はタグで特定)を使い、計測フラグON時のみ
 * `fetchListingsOverviewRowsWithStages`(4本全部の決着を待つ、壁時計
 * 報告専用)を使う——「戻り値の形」(stages/queryTotalsは計測OFF時
 * 常に空配列)は変えていない。
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
    const { rows, stages } = await fetchListingsOverviewRowsWithStages();
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
 * try/catchして「取得できた行(配列)」か「取得エラー(安全な分類情報)」
 * かに落とし、実際の表示(空表示との区別・再試行導線・認証切れの案内)は
 * クライアント側のListingsOverviewTableに委ねる。
 *
 * ## EC一覧P1 実失敗分類(2026-09-13、task_12046ac60ecd86913c)
 *
 * 以前はここで`null`だけを返し、ログにも`err.name`(常に`"Error"`)しか
 * 残していなかった——実際にユーザーの手元で起きた失敗が「4本のうち
 * どれで」「認証切れ/スロットリング/ネットワーク/想定外レスポンスの
 * どれに近いか」を、次に同じ報告が来たときに分類できなかった。
 * `classifyListingsOverviewErrorKind`(lib/listing/overviewFailure.ts)
 * でメッセージ文字列から安全な種別へ分類する——固定ラベルのみで、
 * 商品名・GraphQLメッセージ原文・トークン・IDは一切含まない。分類
 * できない場合は"unknown"のまま返す(指示書§4「unknownをtimeoutと
 * 決めつけない」)。ヒューリスティックである以上、根本原因(AppSync/
 * DynamoDB側で実際に何が起きたか)自体はこの分類だけでは未確定のまま。
 *
 * 失敗段階(`stage`)は2つの経路を両方扱う: 計測OFF(既定、通常UI)の
 * `fetchListingsOverviewRows`が付けた`taggedFailureStage`(fail-fast、
 * 1段階だけの直接タグ)と、計測ON時の`fetchListingsOverviewRowsWithStages`
 * が`attachStageTimings`で添えた4段階ぶんの計測配列
 * (`getStageTimings`+`firstFailedStage`)——通常は前者だけが載っている。
 */
export async function listListingsOverviewSafe(): Promise<ListingsOverviewLoadOutcome<ListingOverviewRow>> {
  try {
    const rows = await listListingsOverview();
    return { ok: true, rows };
  } catch (err) {
    const failure: ListingsOverviewFailureInfo = {
      stage: taggedFailureStage(err) ?? firstFailedStage(getStageTimings(err)),
      kind: classifyListingsOverviewErrorKind(err),
    };
    // ログは固定の安全な分類コードのみ — 商品名・GraphQLメッセージ原文は出さない。
    console.warn("[lib/listing/service.ts] EC出品一覧の取得に失敗しました(ヘッダー等の表示は継続します)", failure);
    return { ok: false, failure };
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
  categoryMapping: MercariCategoryMapping | null;
  overrideTitle: string | null;
  overrideDescription: string | null;
  overridePrice: number | null;
}

/**
 * CSV候補e0fe20760b7a3c2b926f03b58b0c94108b6680fb 不足項目編集→保存→CSV
 * 再生成 未検証の是正(task_48c715588f96367bc9、2026-09-15)で追加。
 * task_e8b97d6b40aad90fff(2026-09-15)で以下2点を是正:
 *
 * 1. 「mercariCategoryIdが空なら保存自体を拒否する」チェックを撤去した。
 *    CSV不足項目(カテゴリー/発送日数/配送料負担)は段階的に埋まる運用
 *    ——先に発送日数だけ確定し、カテゴリーは後で選ぶ——を想定しており、
 *    ここ(下書き途中保存)でカテゴリー確定を強制する根拠が無い。
 *    「CSV化にはカテゴリー確定が必須」という制約自体は既に
 *    lib/listing/mercari/csv/validate.ts(buildMercariCsvExport経由)が
 *    CSV生成の最終段で課しており、そちらと責務が重複していた
 *    (＝下書き保存の検証とCSV最終出力の検証を分離する)。
 * 2. mercariShippingDays/mercariShippingPayerの範囲チェックはchannel
 *    ==="MERCARI_SHOPS"のときだけ行う。categoryMapping自体がMercari
 *    Shops固有のフィールド(mercari*という名前が示す通り)であり、BASE
 *    (app/actions/listing.tsのsaveBaseChannelOverrideAction経由)は
 *    常にcategoryMapping:nullを送るため現状は実害が無いが、旧実装は
 *    channelを一切見ておらず、将来BASE側が何らかのmapping相当を持つ
 *    ようになった場合にMercari専用制約を誤って適用してしまう作りだった。
 * 3. mercariShippingFeeId(task_ca862bd2a1f6fbf60d、2026-09-15追加)は
 *    型(文字列)だけをここで確認する——「配送料の負担が送料別なら必須」
 *    という値の組み合わせチェックはCSV生成時(validateMercariCsvRow、
 *    lib/listing/mercari/csv/validate.ts)側の責務のままにする(ここで
 *    強制すると、指示書§4「途中空欄保存許可」——先に送料別だけ選び、
 *    Mercari管理画面で送料設定を作った後にIDを追記する段階的保存——が
 *    できなくなる)。空文字列はMercariCategoryMappingSection.tsx側が
 *    undefinedへ変換して送るため、ここに空文字列が来ること自体を
 *    不正値として拒否する(黙って許容しない)。
 *
 * MercariCategoryMappingSection.tsxのUIは`<select>`の選択肢で
 * mercariShippingDays(1〜5)/mercariShippingPayer(1〜2)を制限している
 * が、これはあくまでクライアント側の入力補助——Server Action
 * (saveChannelOverrideAction)は誰でも任意の値で直接叩けるため、
 * このUIの制約に依存せずサーバー側でも同じ範囲を確認する(§12
 * 「これは単なるfrontend filterではない」と同じ考え方)。overridePriceは
 * 未入力(null)を許容しつつ、値がある場合は正の整数のみ受け付ける
 * ——CSV出力時の下限(300円、lib/listing/mercari/csv/validate.ts)は
 * ここでは課さない(そちらはMercari CSV固有の制約であり、保存時点では
 * まだCSV化する前提とは限らないため)。overridePrice自体はchannel共通
 * (MERCARI_SHOPS/BASEどちらでも「価格は正の整数」という制約自体は
 * 変わらない)なのでchannelで出し分けない。
 */
function assertValidChannelOverrideInput(channel: ListingChannel, input: ChannelOverrideInput): void {
  const mapping = input.categoryMapping;
  if (mapping && channel === "MERCARI_SHOPS") {
    if (mapping.mercariShippingDays !== undefined && ![1, 2, 3, 4, 5].includes(mapping.mercariShippingDays)) {
      throw new Error("発送までの日数の値が不正です。");
    }
    if (mapping.mercariShippingPayer !== undefined && ![1, 2].includes(mapping.mercariShippingPayer)) {
      throw new Error("配送料の負担の値が不正です。");
    }
    if (mapping.mercariShippingFeeId !== undefined && (typeof mapping.mercariShippingFeeId !== "string" || mapping.mercariShippingFeeId.trim() === "")) {
      throw new Error("送料IDの値が不正です。");
    }
  }
  if (input.overridePrice != null && (!Number.isInteger(input.overridePrice) || input.overridePrice <= 0)) {
    throw new Error("価格は正の整数で入力してください。");
  }
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

  assertValidChannelOverrideInput(channel, input);

  const existing = await getChannelListing(inventoryId, channel);

  // task_48c715588f96367bc9(2026-09-15): saveChannelOverrideActionの
  // 非本番合成境界。上のドラフト要否判定・カテゴリー対象外判定・入力値
  // 検証は本番と全く同じコードを通った"後"にここへ来る(検証ロジック
  // 自体の二重実装ではない)——E2E fixtureモードでは実DynamoDBへ到達
  // せず、プロセス内の合成保存状態へ書く(lib/listing/e2eFixtures.ts
  // のe2eSaveChannelOverride参照)。これによりCSV編集補完UI(カテゴリー
  // /発送日数/配送料負担)の保存→再読込→CSV再生成までを、実UI・実
  // Server Action・実認可/検証を通して実ブラウザで確認できる。
  if (isE2EFixtureModeActive()) {
    return e2eSaveChannelOverride(inventoryId, channel, input, who, existing);
  }

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
 * Mercari Shops API出品機能の撤去(2026-09-14)。
 *
 * 旧`listOnMercari`(Mercariへ実際に出品するServer関数)はここにあった。
 * ユーザーの明示的な指示(P1): 「Mercari Shops API出品機能そのものを
 * 撤去する。無効ボタンや認証待ちとして残す対応では不十分」— 単に
 * ボタンを無効化する/`assertExternalWriteAllowed`で止めるのではなく、
 * この関数自体・呼び出し元(`app/actions/listing.ts`の
 * `listOnMercariAction`)・UI(`ListingForm.tsx`の「Mercariに出品する」
 * ボタン)・アダプタ一式(`lib/listing/mercari/`)を削除した。
 *
 * 既存の`ChannelListing`(過去にMercariへ出品した履歴、status/
 * externalListingId/listingUrl/lastError等)は削除していない —
 * `getChannelListing`/`fetchAllChannelListings`は引き続き
 * `MERCARI_SHOPS`チャネルを読み取り専用で返す(EC一覧・商品詳細の
 * 「過去の出品履歴」表示のため)。BASEチャネル(`listOnBase`、下記)は
 * このタスクの対象外であり、一切変更していない。
 */

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

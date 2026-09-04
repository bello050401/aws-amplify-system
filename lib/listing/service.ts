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
import { unwrapList, unwrapWriteRequired } from "@/lib/amplify/listAll";
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

async function fetchAllChannelListings(channel: ListingChannel): Promise<ChannelListingRecord[]> {
  const items: ChannelListingRecord[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.ChannelListing.list({
      filter: { channel: { eq: channel } },
      limit: 200,
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

async function fetchAllListingDrafts(): Promise<ListingDraftRecord[]> {
  const items: ListingDraftRecord[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.ListingDraft.list({
      filter: { deletedAt: { attributeExists: false } },
      limit: 200,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    if (errors) throw new Error(`出品下書き一覧の取得に失敗しました: ${JSON.stringify(errors)}`);
    items.push(...data.map(toListingDraftRecord));
    nextToken = nt;
    if (items.length >= LISTING_OVERVIEW_MAX_ITEMS) break;
  } while (nextToken);
  return items;
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
export async function listListingsOverview(): Promise<ListingOverviewRow[]> {
  const [inventoryPage, channelListings, drafts, categoryNameOf] = await Promise.all([
    // 対象カテゴリだけをGSIから引く(全件スキャンしない)。
    listEcEligibleInventory(),
    fetchAllChannelListings("MERCARI_SHOPS"),
    fetchAllListingDrafts(),
    loadCategoryNameLookup(),
  ]);

  const channelListingByInventoryId = new Map(channelListings.map((c) => [c.inventoryId, c]));
  const draftInventoryIds = new Set(drafts.map((d) => d.inventoryId));

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

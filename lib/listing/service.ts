import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail, listInventory } from "@/lib/inventory/queries";
import { resolveTopImage, splitImagesByType } from "@/lib/inventory/imageTypes";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { createMercariProduct, MercariApiError } from "./mercari/adapter";
import { isEcListingEligible, buildCategoryNameLookup, ecListingIneligibleReason, type CategoryNameLookup } from "./ecEligibility";
import type {
  ChannelListingRecord,
  ListingChannel,
  ListingConditionCode,
  ListingDraftRecord,
  ListingImageRef,
  ShippingPayerCode,
} from "./types";

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** inventoryIdに紐づくListingDraftを1件だけ返す(存在しなければnull) — DynamoDBに複合ユニーク制約は無いため、「1つのInventoryにつき最大1件」は呼び出し側(このファイル)がlist+filterで確認して守る(ZAICO同期のsourceInventoryId重複防止と同じ考え方)。 */
export async function getListingDraftForInventory(inventoryId: string): Promise<ListingDraftRecord | null> {
  const { data } = await serverDataClient.models.ListingDraft.list({
    filter: { inventoryId: { eq: inventoryId } },
    ...inventoryAuthMode,
  });
  const found = data.find((d) => !d.deletedAt);
  return found ? toListingDraftRecord(found) : null;
}

export async function getChannelListing(inventoryId: string, channel: ListingChannel): Promise<ChannelListingRecord | null> {
  const { data } = await serverDataClient.models.ChannelListing.list({
    filter: { and: [{ inventoryId: { eq: inventoryId } }, { channel: { eq: channel } }] },
    ...inventoryAuthMode,
  });
  return data[0] ? toChannelListingRecord(data[0]) : null;
}

/** lib/inventory/queries.tsのSEARCH_MAX_SCAN_ITEMSと同じ上限 — Inventory自体がその上限を超えない前提なので、Inventoryとjoinするこちらの一括取得も同じ規模で揃えておく。 */
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
export async function listListingsOverview(): Promise<ListingOverviewRow[]> {
  const [inventoryPage, channelListings, drafts, categoryNameOf] = await Promise.all([
    listInventory({}, { offset: 0, limit: LISTING_OVERVIEW_MAX_ITEMS }),
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
  const draft = await getListingDraftForInventory(inventoryId);
  if (!draft) throw new Error("先に出品下書きを保存してください。");

  const channelListing = await getChannelListing(inventoryId, "MERCARI_SHOPS");
  if (!channelListing) throw new Error("先にMercariのカテゴリー設定を保存してください。");

  if (channelListing.status === "ACTIVE" && channelListing.externalListingId) {
    throw new Error(
      `既にMercari Shopsへ出品済みです（商品ID: ${channelListing.externalListingId}）。再出品（更新）は現時点では未対応の機能です。`,
    );
  }

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
  await serverDataClient.models.ChannelListing.update(
    { id: channelListing.id, status: "PUBLISHING", updatedBy: who ?? undefined },
    inventoryAuthMode,
  );

  try {
    const result = await createMercariProduct({ draft, channelListing, shippingPayer, inventoryQuantity: inventory.quantity });
    const nowIso = new Date().toISOString();
    const { data: updated, errors } = await serverDataClient.models.ChannelListing.update(
      {
        id: channelListing.id,
        status: "ACTIVE",
        externalListingId: result.externalProductId,
        listingUrl: null, // [UNVERIFIED] MercariのcreateProduct応答にlistingUrl相当のフィールドが含まれるか未確認 — 含まれることが確認できたらここへ設定する
        // §15: firstListedAtは初回のみ設定(既存値があれば上書きしない)、
        // lastListedAtは成功のたびに更新。このrelist未実装の現状では
        // 実質的に同時刻になるが、フィールドの意味自体は将来の再出品
        // 実装にそのまま使える形にしてある。
        firstListedAt: channelListing.firstListedAt ?? nowIso,
        lastListedAt: nowIso,
        lastError: undefined,
        updatedBy: who ?? undefined,
      },
      inventoryAuthMode,
    );
    if (errors || !updated) throw new Error(`出品結果の保存に失敗しました: ${JSON.stringify(errors)}`);
    return toChannelListingRecord(updated);
  } catch (err) {
    const message = err instanceof MercariApiError ? err.message : err instanceof Error ? err.message : "不明なエラー";
    const { data: failed } = await serverDataClient.models.ChannelListing.update(
      { id: channelListing.id, status: "ERROR", lastError: message, updatedBy: who ?? undefined },
      inventoryAuthMode,
    );
    console.error(`[listOnMercari] inventoryId=${inventoryId} failed:`, err);
    if (failed) return toChannelListingRecord(failed);
    throw err;
  }
}

/**
 * scripts/verify-listings-overview-service-boundary.ts 専用fixture。
 *
 * scripts/__mocks__/inventoryHistory.dataClient.mock.cjs と同じ設計
 * (lib/amplify/dataClient.ts の `serverDataClient`/`inventoryAuthMode`
 * だけを差し替える、本物のGraphQL呼び出しは一切行わない) だが、
 * lib/listing/service.ts の listListingsOverview が実際に呼ぶ4つの
 * モデル(Category / Inventory / ChannelListing / ListingDraft)ぶんを
 * まとめて持つ——4つとも「ページtoken(nextToken)を渡された分だけ
 * 進む」「limitで指定された件数どおりに切り出す」「エラー/reject を
 * 注入できる」という同じ形の挙動をするので、1つのページング関数
 * (`makePagedList`)を使い回す。
 */

function makePagedList(items, callLog) {
  let rejection = null;
  let forcedErrors = null;
  const state = {
    /** 次の list() 呼び出しをGraphQL errors(dataは空でも通常発生する形)にする。 */
    setErrors(errors) {
      forcedErrors = errors;
      rejection = null;
    },
    /** 次の list() 呼び出しをreject(通信断等の非GraphQLエラー)にする。 */
    setRejection(err) {
      rejection = err;
      forcedErrors = null;
    },
    reset() {
      rejection = null;
      forcedErrors = null;
    },
  };
  async function list(opts) {
    callLog.push({ ...opts });
    if (rejection) throw rejection;
    if (forcedErrors) return { data: [], errors: forcedErrors };
    const limit = opts.limit ?? 100;
    const start = opts.nextToken ? Number(opts.nextToken) : 0;
    const slice = items.slice(start, start + limit);
    const nextIndex = start + limit;
    const nextToken = nextIndex < items.length ? String(nextIndex) : null;
    return { data: slice, nextToken, errors: undefined };
  }
  return { list, state };
}

// ── Category: 対象カテゴリ2件 + 対象外カテゴリ1件(isEcListingEligibleの
//    フィルタが実際に効くことを確認するため、除外名を1つ混ぜる)。────
const categoryCalls = [];
const categoryItems = [
  { id: "cat-chair", name: "チェア", sortOrder: 1, isActive: true },
  { id: "cat-desk", name: "デスク", sortOrder: 2, isActive: true },
  { id: "cat-shipped", name: "発送完了", sortOrder: 3, isActive: true }, // EXCLUDED_CATEGORY_NAMES(lib/listing/ecEligibility.ts)
];
const categoryMock = makePagedList(categoryItems, categoryCalls);

// ── Inventory (GSI: listInventoryByCategoryId): カテゴリごとに件数を
//    変え、chair側は2ページに跨るようにする(PAGE_SIZE=200なので250件)。
const inventoryCalls = [];
function inventoryRow(categoryId, i) {
  const now = new Date(2026, 8, 1, 0, 0, i).toISOString();
  return {
    id: `${categoryId}-${i}`,
    sku: `SKU-${categoryId}-${i}`,
    sourceSystem: null,
    sourceInventoryId: null,
    name: `商品${categoryId}-${i}`,
    categoryId,
    statusId: null,
    locationId: null,
    quantity: 1,
    unit: null,
    purchasePrice: null,
    salePrice: 1000 + i,
    plannedSalePrice: null,
    note: null,
    images: undefined,
    createdAt: now,
    updatedAt: now,
    barcode: null,
    saleCommission: null,
  };
}
const inventoryByCategory = {
  "cat-chair": Array.from({ length: 250 }, (_, i) => inventoryRow("cat-chair", i)), // 200件上限を跨ぐ→2ページ
  "cat-desk": Array.from({ length: 10 }, (_, i) => inventoryRow("cat-desk", i)),
};
let inventoryRejection = null;
async function listInventoryByCategoryId(key, opts) {
  inventoryCalls.push({ key, opts: { ...opts } });
  if (inventoryRejection) throw inventoryRejection;
  const items = inventoryByCategory[key.categoryId] ?? [];
  const limit = opts.limit ?? 100;
  const start = opts.nextToken ? Number(opts.nextToken) : 0;
  const slice = items.slice(start, start + limit);
  const nextIndex = start + limit;
  const nextToken = nextIndex < items.length ? String(nextIndex) : null;
  return { data: slice, nextToken, errors: undefined };
}

// ── ChannelListing / ListingDraft: Scan相当。limitがLISTING_OVERVIEW_PAGE_SIZE
//    (1000)どおりに渡っているかをここで検証できるよう、要求されたlimitを
//    そのままcallLogへ記録する。
const channelListingCalls = [];
const channelListingItems = [
  {
    id: "cl-1",
    listingDraftId: "ld-1",
    inventoryId: "cat-chair-0",
    channel: "MERCARI_SHOPS",
    status: "ACTIVE",
    externalListingId: "ext-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];
const channelListingMock = makePagedList(channelListingItems, channelListingCalls);

const listingDraftCalls = [];
const listingDraftItems = [
  {
    id: "ld-2",
    inventoryId: "cat-desk-0",
    title: "デスク下書き",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];
const listingDraftMock = makePagedList(listingDraftItems, listingDraftCalls);

const inventoryAuthMode = { authMode: "userPool" };

const serverDataClient = {
  models: {
    Category: { list: categoryMock.list },
    Inventory: { listInventoryByCategoryId },
    ChannelListing: { list: channelListingMock.list },
    ListingDraft: { list: listingDraftMock.list },
  },
};

module.exports = {
  serverDataClient,
  inventoryAuthMode,
  calls: {
    category: categoryCalls,
    inventory: inventoryCalls,
    channelListing: channelListingCalls,
    listingDraft: listingDraftCalls,
  },
  __setInventoryRejection(err) {
    inventoryRejection = err;
  },
  __resetInventoryRejection() {
    inventoryRejection = null;
  },
  __channelListingState: channelListingMock.state,
  __listingDraftState: listingDraftMock.state,
  __resetCallLogs() {
    categoryCalls.length = 0;
    inventoryCalls.length = 0;
    channelListingCalls.length = 0;
    listingDraftCalls.length = 0;
  },
};

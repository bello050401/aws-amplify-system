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
  // 2026-09-13 EC計測レビュー補正: 壁時計の段階待ち時間(elapsedMs)と
  // model.opの累積往復ms(groupTimingsByOp)を区別できることを実service
  // 経由で検証するため、1回のlist()呼び出しに合成の待ち時間を持たせ
  // られるようにする——既定は0(遅延無し)で、既存の呼び出し側の挙動は
  // 変わらない。
  let delayMs = 0;
  // 2026-09-13 補正(task_2c27a70778613453ed): fail-fast試験用——
  // 「1本が失敗する一方、別の1本は決着しないまま(ハングしたまま)」を
  // 再現する。素朴に長いdelayMsでは有限時間で決着してしまい「本当に
  // 待たなかったか」の証明にならないため、実際に一度も解決/拒否しない
  // Promiseを返す。
  let neverResolves = false;
  const state = {
    /** 次の list() 呼び出しをGraphQL errors(dataは空でも通常発生する形)にする。 */
    setErrors(errors) {
      forcedErrors = errors;
      rejection = null;
      neverResolves = false;
    },
    /** 次の list() 呼び出しをreject(通信断等の非GraphQLエラー)にする。 */
    setRejection(err) {
      rejection = err;
      forcedErrors = null;
      neverResolves = false;
    },
    /** 以降のlist()呼び出し1回ごとに実際に待つms(合成遅延、setTimeout)。実測用で0が既定。 */
    setDelayMs(ms) {
      delayMs = ms;
    },
    /** 以降のlist()呼び出しを永久に未解決のままにする(fail-fast試験専用)。 */
    setNeverResolves() {
      neverResolves = true;
      rejection = null;
      forcedErrors = null;
    },
    reset() {
      rejection = null;
      forcedErrors = null;
      delayMs = 0;
      neverResolves = false;
    },
  };
  async function list(opts) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    callLog.push({ ...opts });
    if (neverResolves) return new Promise(() => {});
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
// 2026-09-13 EC計測レビュー補正: makePagedListと同じ合成遅延(実測用、既定0)。
let inventoryDelayMs = 0;
// 「途中ページ失敗」(2ページ目以降で初めて失敗する)を再現するための
// 呼び出し回数カウンタ——nに達するまでの呼び出しは成功させ、n回を
// 超えた呼び出しだけを失敗させる。カテゴリごとの並列実行と組み合わさる
// ため「何回目の呼び出しで失敗するか」で表現する(「何ページ目」は
// カテゴリをまたいで数えると曖昧になるため)。
let inventoryCallCounter = 0;
let inventoryRejectAfterCalls = null;
async function listInventoryByCategoryId(key, opts) {
  if (inventoryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, inventoryDelayMs));
  inventoryCalls.push({ key, opts: { ...opts } });
  inventoryCallCounter++;
  if (inventoryRejection) throw inventoryRejection;
  if (inventoryRejectAfterCalls !== null && inventoryCallCounter > inventoryRejectAfterCalls) {
    throw new Error(`GSI throttled (call #${inventoryCallCounter})`);
  }
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
  /** 合成遅延(ms)。実測用、既定0。 */
  __setInventoryDelayMs(ms) {
    inventoryDelayMs = ms;
  },
  __resetInventoryDelayMs() {
    inventoryDelayMs = 0;
  },
  /** n回目までのInventory.listInventoryByCategoryId呼び出しは成功させ、それ以降を失敗させる(「途中ページ失敗」の再現)。 */
  __setInventoryRejectAfterCalls(n) {
    inventoryRejectAfterCalls = n;
  },
  __resetInventoryRejectAfterCalls() {
    inventoryRejectAfterCalls = null;
  },
  __categoryState: categoryMock.state,
  __channelListingState: channelListingMock.state,
  __listingDraftState: listingDraftMock.state,
  __resetCallLogs() {
    categoryCalls.length = 0;
    inventoryCalls.length = 0;
    channelListingCalls.length = 0;
    listingDraftCalls.length = 0;
    inventoryCallCounter = 0;
  },
};

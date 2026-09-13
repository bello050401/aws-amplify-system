/**
 * EC一覧P1 レビュー補正(2026-09-13)専用のPlaywright E2E fixture。
 *
 * 【なぜ必要か】lib/inventory/e2eFixtures.ts と同じ理由 —
 * このsandbox環境には実AWS(AppSync)への到達経路が無く、
 * listListingsOverview はCategory/Inventory(GSI)/ChannelListing/
 * ListingDraft の4本を実際に呼ぶため、そのままではE2Eで
 * `INVENTORY_E2E_FIXTURES=1` を立てても失敗する(listListingsOverviewSafe
 * が`{ok:false, failure}`へ落とすので一覧はerror状態になり、364件描画・
 * 検索・絞込・ページ移動・選択維持を実ブラウザで検証できない)。
 *
 * 【安全設計】lib/inventory/e2eFixtures.ts と同じ二重ゲート
 * (isE2EFixtureModeActive — NODE_ENV!=='production' かつ
 * INVENTORY_E2E_FIXTURES==='1')の**内側**でのみ呼ばれる
 * (呼び出し元: lib/listing/service.ts の listListingsOverview 冒頭)。
 * 書き込み系には一切関与しない(読み取り一覧の表示検証専用)。
 *
 * 【件数・構成】364件(タスク指示書§7「実React一覧364件以上」に対応):
 *   - 先頭20件: channelListing無し・hasDraft=false → NOT_STARTED
 *     (一括下書き作成の対象になり得る行)
 *   - 次の20件: channelListing無し・hasDraft=true → DRAFT
 *     (既に下書きがあるので一括作成の対象から除外される行 —
 *     selectableInventoryIdsの検証に使う)
 *   - 残り324件: ListingStatusの12値を27件ずつ均等に割り当てた
 *     channelListingを持つ行(状態絞り込みの各バケットに複数件を保証する)。
 * 先頭1件(index 0)には検索テスト用の一意な名前を付けてある。
 */
import type { ListingOverviewRow } from "./service";
import type { ChannelListingRecord, ListingDraftRecord, ListingStatus } from "./types";
import { DEFAULT_LISTING_SHIPPING_METHOD } from "./types";

const ALL_STATUSES: ListingStatus[] = [
  "NOT_PREPARED",
  "DRAFT",
  "READY",
  "QUEUED",
  "PUBLISHING",
  "ACTIVE",
  "PAUSED",
  "SOLD",
  "ENDED",
  "RELIST_PENDING",
  "ERROR",
  "ARCHIVED",
];

const NOW = "2026-09-01T00:00:00.000Z";

function makeChannelListing(inventoryId: string, status: ListingStatus): ChannelListingRecord {
  return {
    id: `e2e-cl-${inventoryId}`,
    listingDraftId: `e2e-ld-${inventoryId}`,
    inventoryId,
    channel: "MERCARI_SHOPS",
    categoryMapping: null,
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status,
    externalListingId: status === "ACTIVE" || status === "SOLD" ? `ext-${inventoryId}` : null,
    listingUrl: null,
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeRow(i: number, overrides: Partial<ListingOverviewRow> = {}): ListingOverviewRow {
  const id = `e2e-listing-${i}`;
  return {
    inventoryId: id,
    displayId: `E2E-${String(i).padStart(4, "0")}`,
    name: `E2Eテスト出品-${i}`,
    quantity: 1,
    price: 1000 + i,
    thumbnailKey: null,
    inventoryUpdatedAt: NOW,
    hasDraft: false,
    channelListing: null,
    ...overrides,
  };
}

const TOTAL_ROWS = 364;
const NOT_STARTED_COUNT = 20;
const DRAFT_COUNT = 20;

function buildRows(): ListingOverviewRow[] {
  const rows: ListingOverviewRow[] = [];
  for (let i = 0; i < NOT_STARTED_COUNT; i++) {
    rows.push(makeRow(i, { hasDraft: false, channelListing: null }));
  }
  for (let i = NOT_STARTED_COUNT; i < NOT_STARTED_COUNT + DRAFT_COUNT; i++) {
    rows.push(makeRow(i, { hasDraft: true, channelListing: null }));
  }
  let statusIndex = 0;
  for (let i = NOT_STARTED_COUNT + DRAFT_COUNT; i < TOTAL_ROWS; i++) {
    const status = ALL_STATUSES[statusIndex % ALL_STATUSES.length];
    statusIndex++;
    rows.push(makeRow(i, { channelListing: makeChannelListing(`e2e-listing-${i}`, status) }));
  }
  // 検索テスト用: 一意な名前を持つ1件を先頭に混ぜる(既存のNOT_STARTED行を上書き)。
  rows[0] = makeRow(0, { name: "検索対象サンプルチェアA", hasDraft: false, channelListing: null });
  return rows;
}

const E2E_LISTINGS_OVERVIEW_ROWS: ListingOverviewRow[] = buildRows();

/**
 * 呼び出し回数で挙動を変える(Playwrightの単一共有dev serverプロセス内で
 * 「初回は失敗、再試行(reload/retryボタン)で成功」を決定的に再現する —
 * lib/inventory/e2eFixtures.ts の e2e-inv-8(historyFailOnceCounts)と
 * 同じ発想)。
 *
 * 【実測で踏んだ罠】素朴なmodule-scopeの`let callCount`だと壊れる——
 * Next.js devモードは、この一覧の初回取得(Server Component/RSC層)と
 * 再試行(app/actions/listing.tsのServer Action層)を**別々のwebpack
 * モジュールインスタンス**としてコンパイルする(実際にサーバーログで
 * `callCount===1`が2回とも真になるのを確認した——RSC層側の`let`と
 * Server Action層側の`let`が別モノになっている)。同じNode.jsプロセス内
 * では常に1つである`globalThis`をカウンタの置き場にすることで、
 * どちらの層から呼ばれても同じ値を共有させる。
 *
 * 1回目: reject(read rejectionからの局所復帰を検証)。
 * 2回目以降: 実際のGSI Query + Scan往復を模した5秒遅延の後、364件を返す
 * (ヘッダー・検索欄が取得完了を待たずに表示されることを検証)。
 */
const CALL_COUNT_KEY = Symbol.for("bello.e2eListingsOverviewFetch.callCount");
type GlobalWithCallCount = typeof globalThis & { [CALL_COUNT_KEY]?: number };

export async function e2eListingsOverviewFetch(): Promise<ListingOverviewRow[]> {
  const g = globalThis as GlobalWithCallCount;
  const callCount = (g[CALL_COUNT_KEY] ?? 0) + 1;
  g[CALL_COUNT_KEY] = callCount;
  if (callCount === 1) {
    throw new Error("[e2e-fixture] simulated listListingsOverview transient failure (recovers on retry)");
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return E2E_LISTINGS_OVERVIEW_ROWS;
}

/**
 * 2026-09-14 指示書レビュー修正: EC出品個別編集画面(app/inventory/
 * (protected)/[id]/listing/ListingForm.tsx)の「出品内容をコピー
 * （手動出品用）」ボタン・AutoPricingSectionのmanual-only注記は、
 * どちらも「下書き(ListingDraft)とChannelListing(MERCARI_SHOPS)が
 * 既に存在する」商品でしか描画されない(ボタンは`disabled={!draft}`、
 * AutoPricingSectionは`{channelListing && (...)}`)。
 *
 * 従来のlib/listing/service.tsのgetListingDraftForInventory/
 * getChannelListingは、fixtureモードでは商品を問わず常にnullを返して
 * いた(第六ラウンドP0-1)——一覧・画像等の既存E2Eには十分だったが、
 * このボタン・セクション自体を実ブラウザでクリックして確かめる経路が
 * 無かった。lib/inventory/e2eFixtures.tsに専用に追加したe2e-inv-30
 * だけ、この2つの合成レコードを返す(他のidは従来通りnull——既存の
 * listing-layout.spec.ts等はe2e-inv-1を使っており挙動は変えない)。
 */
export const E2E_MANUAL_ONLY_INVENTORY_ID = "e2e-inv-30";

const E2E_MANUAL_ONLY_NOW = "2026-09-14T00:00:00.000Z";

export function e2eManualOnlyListingDraft(): ListingDraftRecord {
  return {
    id: "e2e-fixture-ld-30",
    inventoryId: E2E_MANUAL_ONLY_INVENTORY_ID,
    title: "【E2Eテスト】北欧デザインダイニングチェア ウォールナット材 30号",
    description: "手動出品支援の実ブラウザ検証専用の合成下書き説明文です。",
    price: 27800,
    condition: "NO_NOTABLE_DAMAGE",
    shippingMethod: DEFAULT_LISTING_SHIPPING_METHOD,
    images: [],
    createdBy: "e2e-fixture",
    updatedBy: "e2e-fixture",
    createdAt: E2E_MANUAL_ONLY_NOW,
    updatedAt: E2E_MANUAL_ONLY_NOW,
  };
}

export function e2eManualOnlyChannelListing(): ChannelListingRecord {
  return {
    id: "e2e-fixture-cl-30",
    listingDraftId: "e2e-fixture-ld-30",
    inventoryId: E2E_MANUAL_ONLY_INVENTORY_ID,
    channel: "MERCARI_SHOPS",
    categoryMapping: null,
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status: "DRAFT",
    externalListingId: null,
    listingUrl: null,
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
    createdAt: E2E_MANUAL_ONLY_NOW,
    updatedAt: E2E_MANUAL_ONLY_NOW,
  };
}

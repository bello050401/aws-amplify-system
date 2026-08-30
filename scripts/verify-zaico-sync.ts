/**
 * BELLO統合改修 master指示書 Phase A: standalone (no test framework in
 * this repo — vitest/jest are not installed) unit/integration-style
 * verification for the ZAICO background sync's actual business logic:
 * dedup/create/update/unchanged/failure-isolation via a fully in-memory
 * mock ZaicoSyncPort (no AWS calls at all), the background job's pure
 * checkpoint helpers, and the purchasePrice all-in-原価 profit rule that
 * must survive every phase of this round unchanged.
 *
 * Run with: npm run verify:zaico
 * (must go through scripts/with-server-only-stub.cjs — see that file's
 * comment for why: zaicoSync.ts and its dependencies are marked
 * `server-only`, which throws when `require`d outside Next.js unless
 * that package is temporarily stubbed for this one run.)
 *
 * Exits with a non-zero status if any assertion fails, so it can be
 * wired into CI later without any changes.
 */
import { syncOneZaicoItem } from "@/lib/inventory/zaicoSync";
import type { ZaicoSyncPort, InventoryModel, NewInventoryInput, UpdateInventoryInput } from "@/lib/inventory/zaicoSyncPorts";
import type { HistoryFieldChange } from "@/lib/inventory/history";
import { parseSeenSourceIds, toPublicJob } from "@/lib/inventory/zaicoBackgroundSync";
import { summarizeSales, summarizeMonthlyTrend, calculateItemGrossProfit } from "@/lib/inventory/sales";
import { resizeToThumbnailJpeg, THUMBNAIL_MAX_DIMENSION } from "@/lib/inventory/thumbnail";
import { effectiveListThumbnailKey, type InventoryImageRecord } from "@/lib/inventory/imageTypes";
import { compareByUpdatedAtDesc } from "@/lib/inventory/queries";
import sharp from "sharp";
import type { ZaicoInventory } from "@/lib/zaico/client";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

// ── In-memory mock ZaicoSyncPort ──────────────────────────────────────
// Models exactly the parts of the real serverDataClient-backed adapter
// (zaicoSyncPorts.ts's createServerSyncPort) that syncOneZaicoItem
// actually depends on, without touching AWS: a Map keyed by id acting as
// the "Inventory table", auto-incrementing ids/SKUs, and call counters so
// the tests below can assert e.g. "unchanged never calls createInventory
// /updateInventory" (idempotency) without inspecting private state.
function createMockPort() {
  const store = new Map<string, InventoryModel>();
  const categories = new Map<string, string>();
  const locations = new Map<string, string>();
  const historyLog: { inventoryId: string; who: string | null; changes: HistoryFieldChange[] }[] = [];
  const removedImages: string[] = [];
  // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.7: 実DBの
  // ZaicoSourceLinkと同じ「sourceInventoryId → inventoryId」の排他claim
  // をin-memoryで模倣する — claimSourceLink/releaseSourceLinkのテスト
  // (同時実行相当のシナリオを含む)に使う。
  const claimedLinks = new Map<string, string>();
  let nextSkuNum = 1;

  // BELLO ZAICO級高速化仕様書 §30.7: prefetched map / masterCacheが
  // 実際にpore呼び出しを削減していることを検証する(testPrefetchAndMasterCacheAvoidRepeatedLookups)
  // ためのcall counter — findExistingBySourceId/findOrCreateCategory/
  // findOrCreateLocationは全て「呼ばれるたびに高コストなScan相当」を
  // 表す操作なので、この3つの呼び出し回数を数える。
  const calls = { createInventory: 0, updateInventory: 0, generateSku: 0, findExistingBySourceId: 0, findOrCreateCategory: 0, findOrCreateLocation: 0 };

  const port: ZaicoSyncPort = {
    async findExistingBySourceId(sourceInventoryId) {
      calls.findExistingBySourceId++;
      for (const v of store.values()) {
        if (v.sourceInventoryId === sourceInventoryId && !v.deletedAt) return v;
      }
      return null;
    },
    async fetchAllZaicoManaged() {
      const map = new Map<string, InventoryModel>();
      for (const v of store.values()) {
        if (v.sourceSystem === "ZAICO" && !v.deletedAt && v.sourceInventoryId) map.set(v.sourceInventoryId, v);
      }
      return map;
    },
    async findOrCreateCategory(name: string) {
      calls.findOrCreateCategory++;
      if (categories.has(name)) return { id: categories.get(name)!, created: false };
      const id = `cat-${categories.size + 1}`;
      categories.set(name, id);
      return { id, created: true };
    },
    async findOrCreateLocation(name: string) {
      calls.findOrCreateLocation++;
      if (locations.has(name)) return { id: locations.get(name)!, created: false };
      const id = `loc-${locations.size + 1}`;
      locations.set(name, id);
      return { id, created: true };
    },
    async generateSku() {
      calls.generateSku++;
      return `SKU-${String(nextSkuNum++).padStart(4, "0")}`;
    },
    async createInventory(input: NewInventoryInput) {
      calls.createInventory++;
      // input.idはclaimSourceLinkで既に確保済み(実装と同じ「明示id指定
      // create」規約) — この関数がidを新規発行することはない。
      const record = { ...input } as unknown as InventoryModel;
      store.set(input.id, record);
      return record;
    },
    async claimSourceLink(sourceInventoryId, inventoryId) {
      const existing = claimedLinks.get(sourceInventoryId);
      if (existing !== undefined) return { claimed: false, existingInventoryId: existing };
      claimedLinks.set(sourceInventoryId, inventoryId);
      return { claimed: true };
    },
    async releaseSourceLink(sourceInventoryId) {
      claimedLinks.delete(sourceInventoryId);
    },
    async updateInventory(input: UpdateInventoryInput) {
      calls.updateInventory++;
      const existing = store.get(input.id);
      if (!existing) throw new Error(`mock: no such id ${input.id}`);
      store.set(input.id, { ...existing, ...input } as unknown as InventoryModel);
    },
    async logHistory(inventoryId, who, changes) {
      historyLog.push({ inventoryId, who, changes });
    },
    async downloadAndImportImage(url: string) {
      return { storageKey: `mock-storage-key-for/${url}`, thumbnailKey: `mock-thumbnail-key-for/${url}`, originalHash: `mock-hash-for/${url}` };
    },
    async removeImage(path: string) {
      removedImages.push(path);
    },
  };

  return { port, store, historyLog, removedImages, calls };
}

function makeZaicoItem(overrides: Partial<ZaicoInventory> = {}): ZaicoInventory {
  return {
    id: 1001,
    title: "テスト商品A",
    quantity: 3,
    unit: "個",
    category: "家具",
    place: "倉庫A",
    etc: null,
    code: null,
    item_image: null,
    optional_attributes: [
      { name: "⚫︎購入価格", value: "6000" },
      { name: "⚫︎販売価格", value: "12000" },
    ],
    ...overrides,
  } as ZaicoInventory;
}

async function testCreateThenIdempotentUnchanged() {
  const { port, store, calls } = createMockPort();
  const item = makeZaicoItem();

  const first = await syncOneZaicoItem(item, "tester@example.com", undefined, port);
  assertEqual(first.status, "created", "new ZAICO item syncs as created");
  assertEqual(calls.createInventory, 1, "created exactly one Inventory record");
  assertEqual(store.size, 1, "mock store has exactly one record after first sync");

  // Re-syncing the exact same item (a second `advance` page overlapping,
  // or a re-run after a resumed background job) must find the existing
  // record by sourceInventoryId and treat it as unchanged — never a
  // second create. This is the duplicate-prevention/idempotency
  // requirement from the master instructions, exercised directly.
  const second = await syncOneZaicoItem(item, "tester@example.com", undefined, port);
  assertEqual(second.status, "unchanged", "re-syncing the identical item is a no-op (idempotent)");
  assertEqual(calls.createInventory, 1, "re-sync does not call createInventory again");
  assertEqual(calls.updateInventory, 0, "re-sync of an unchanged item does not call updateInventory either");
  assertEqual(store.size, 1, "mock store still has exactly one record (no duplicate created)");
}

async function testUpdateOnRealChange() {
  const { port, calls } = createMockPort();
  const item = makeZaicoItem();
  await syncOneZaicoItem(item, "tester@example.com", undefined, port);

  const changed = makeZaicoItem({ quantity: 7 });
  const result = await syncOneZaicoItem(changed, "tester@example.com", undefined, port);
  assertEqual(result.status, "updated", "a real field change (quantity 3→7) syncs as updated");
  assertEqual(calls.updateInventory, 1, "exactly one updateInventory call for the changed field");
}

async function testFailureIsolation() {
  const { port } = createMockPort();
  const brokenPort: ZaicoSyncPort = {
    ...port,
    async generateSku() {
      throw new Error("mock SKU service unavailable");
    },
  };
  const item = makeZaicoItem({ id: 2002 });
  const result = await syncOneZaicoItem(item, "tester@example.com", undefined, brokenPort);
  assertEqual(result.status, "failed", "a per-item failure is caught and reported, not thrown");
  assertTrue(typeof result.error === "string" && result.error.includes("mock SKU service unavailable"), "failure carries the underlying error message");
}

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.11: 実データで
 * 確認されたZAICO在庫ID重複(例: "50666071")の再発防止テスト。
 * §11.6の同期不変条件(source IDなし→CREATE、あり+変更→UPDATE、
 * あり+同一→SKIP)と§11.7のDB層防止(claimSourceLink)を、10項目の
 * 回帰シナリオとして検証する。
 */
async function testClaimSourceLinkAtomicity() {
  const { port } = createMockPort();
  const first = await port.claimSourceLink("9001", "inv-a");
  assertEqual(first, { claimed: true }, "claimSourceLink: 未claimのsourceInventoryIdは最初のclaimが成功する");

  const second = await port.claimSourceLink("9001", "inv-b");
  assertEqual(second, { claimed: false, existingInventoryId: "inv-a" }, "claimSourceLink: 同じsourceInventoryIdへの2回目のclaimは失敗し、既存の保持者を返す(§11.7 DB層での排他制御)");

  await port.releaseSourceLink("9001");
  const third = await port.claimSourceLink("9001", "inv-c");
  assertEqual(third, { claimed: true }, "claimSourceLink: releaseSourceLink後は再びclaimできる(失敗したcreateの後始末が次の再試行を妨げない)");
}

/**
 * 実際に発見された不具合の核心を直接再現する: `findExistingBySourceId`
 * が(単発list()のスキャン範囲外に落ちる等の理由で)既存レコードを
 * 「見つからない」と誤判定し続けても、`claimSourceLink`によるDB層の
 * 排他制御だけで2件目のInventory作成を防げることを検証する——
 * 「アプリ側の検索ロジックが完全に信用できない最悪のケース」を想定した
 * 防御的テスト(findExistingBySourceIdを常にnullへ固定する)。
 */
async function testRaceDuringSingleItemSyncIsCaughtByClaim() {
  const { port, store, calls } = createMockPort();
  const blindPort: ZaicoSyncPort = {
    ...port,
    async findExistingBySourceId() {
      return null; // 実際の不具合(既存レコードを見逃す)を意図的に再現
    },
  };
  const item = makeZaicoItem({ id: 5001 });

  const first = await syncOneZaicoItem(item, "tester@example.com", undefined, blindPort);
  assertEqual(first.status, "created", "重複防止テスト1回目: findExistingBySourceIdが常にnullでも新規作成される");
  assertEqual(calls.createInventory, 1, "重複防止テスト1回目: createInventoryが1回呼ばれる");

  const second = await syncOneZaicoItem(item, "tester@example.com", undefined, blindPort);
  assertEqual(calls.createInventory, 1, "重複防止テスト2回目: findExistingBySourceIdが見逃してもclaimSourceLinkの排他制御でcreateInventoryが2回目呼ばれない(重複防止の核心)");
  assertEqual(store.size, 1, "重複防止テスト2回目の後もInventoryは1件のまま(重複が作られていない)");
  // findExistingBySourceId自体が常にnullを返す設計のこのport variantでは、
  // claim失敗後の再取得もnullになる——「リンクはあるがInventoryが
  // 見つからない」不整合として安全側にfailedを返すのが正しい挙動
  // (無理やり2件目を作ることは絶対にしない、という設計判断の検証)。
  assertEqual(second.status, "failed", "重複防止テスト2回目: ルックアップ自体が壊れている場合は安全側でfailedを返す(強引な重複作成はしない)");
}

/** 同じ防御を、単発同期(prefetched無し)ではなくバッチ/resume経路(prefetchedあり)でも検証する。 */
async function testRaceDuringBatchSyncIsCaughtByClaim() {
  const { port, store, calls } = createMockPort();
  const item = makeZaicoItem({ id: 5002 });

  // resumeが「まだこの商品を見ていない」という(古い/不完全な)prefetched
  // mapを渡すケースを模す——空のMapを渡し続けても、claimSourceLinkが
  // 2回目以降のcreateを防ぐことを確認する。
  const first = await syncOneZaicoItem(item, "tester@example.com", new Map(), port);
  assertEqual(first.status, "created", "resume経路1回目: 空のprefetchedでも新規作成される");
  assertEqual(calls.createInventory, 1, "resume経路1回目: createInventoryが1回呼ばれる");

  const second = await syncOneZaicoItem(item, "tester@example.com", new Map(), port);
  assertEqual(calls.createInventory, 1, "resume経路2回目: 別の空prefetchedでもclaimSourceLinkが重複createを防ぐ");
  assertEqual(store.size, 1, "resume経路2回目の後もInventoryは1件のまま");
  // このport(createMockPort())自体のfindExistingBySourceIdはstore全体を
  // 正しく走査する(実装のO(1) get+完全フォールバックスキャンに相当)ので、
  // claim失敗後の再取得は実際に既存レコードを見つける——内容は1回目と
  // 同一(makeZaicoItemの既定値のまま)なのでunchangedと判定される
  // (failedにもcreatedにもならない=重複が作られていないことの確認)。
  assertEqual(second.status, "unchanged", "resume経路2回目: claim失敗後の再取得で正しく既存レコードが見つかり、unchangedとして扱われる(failedにも新規createにもならない)");
}

/** §11.11 項目8: number/string境界は同一sourceとして扱われる(syncOneZaicoItemのString(zaicoItem.id)正規化の回帰確認)。 */
async function testNumberStringIdBoundaryTreatedAsSameSource() {
  const { port, store, calls } = createMockPort();
  const numericItem = makeZaicoItem({ id: 6001 });
  await syncOneZaicoItem(numericItem, "tester@example.com", undefined, port);
  assertEqual(calls.createInventory, 1, "number形式のidで1件作成");

  const stringItem = makeZaicoItem({ id: "6001" as unknown as number });
  const result = await syncOneZaicoItem(stringItem, "tester@example.com", undefined, port);
  assertEqual(result.status, "unchanged", "number/string境界: 同じ実体を指すidは同一sourceとして扱われ、unchangedになる(重複作成されない)");
  assertEqual(calls.createInventory, 1, "number/string境界: createInventoryは1回のまま増えない");
  assertEqual(store.size, 1, "number/string境界: Inventoryは1件のまま");
}

/** §11.11 項目10: 実例(ZAICO在庫ID"50666071")を象徴的に使い、繰り返し同期しても件数が増えないことを検証する。 */
async function testRepeatedFullResyncNeverIncreasesCount() {
  const { port, store, calls } = createMockPort();
  const item = makeZaicoItem({ id: 50666071 });
  for (let i = 0; i < 5; i++) {
    await syncOneZaicoItem(item, "tester@example.com", undefined, port);
  }
  assertEqual(calls.createInventory, 1, "ZAICO在庫ID50666071相当: 5回同期してもcreateInventoryは最初の1回だけ");
  assertEqual(store.size, 1, "ZAICO在庫ID50666071相当: 5回同期してもInventoryは1件のまま(実データで確認された重複の再発防止)");
}

/** createInventory自体が失敗した場合、claimしたリンクが解放され、次の再試行が「既に誰かが保持している」と誤判定されないことを検証する(§11.8 同時実行/retry)。 */
async function testCreateFailureReleasesClaimForRetry() {
  const { port, store } = createMockPort();
  let shouldFail = true;
  const flakyPort: ZaicoSyncPort = {
    ...port,
    async createInventory(input: NewInventoryInput) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("mock: 一時的な書き込み失敗");
      }
      return port.createInventory(input);
    },
  };
  const item = makeZaicoItem({ id: 7001 });

  const first = await syncOneZaicoItem(item, "tester@example.com", undefined, flakyPort);
  assertEqual(first.status, "failed", "retryテスト1回目: createInventory失敗はfailedとして報告される");
  assertEqual(store.size, 0, "retryテスト1回目の後、Inventoryは1件も作られていない");

  const second = await syncOneZaicoItem(item, "tester@example.com", undefined, flakyPort);
  assertEqual(second.status, "created", "retryテスト2回目: releaseSourceLinkにより再試行が正しく新規作成として成功する(失敗したclaimに永久にブロックされない)");
  assertEqual(store.size, 1, "retryテスト2回目の後、Inventoryは正しく1件作成されている");
}

/**
 * BELLO ZAICO級高速化仕様書 §30.7: baseline計測(scripts/
 * benchmark-zaico-sync.ts)で確定した2つのN+1(sourceInventoryIdの
 * 全件Scan、Category/Locationマスタの全件取得)がprefetched map /
 * masterCacheで実際に回避されることを、呼び出し回数レベルで検証する
 * ——ミリ秒の計測ではなく「該当port関数が呼ばれた回数」という決定論的
 * な指標でのregressionテスト。
 */
async function testPrefetchAndMasterCacheAvoidRepeatedLookups() {
  const { port, calls } = createMockPort();
  // 3件、同じカテゴリ/場所名を共有する既存ZAICO商品を用意。
  for (const id of [3001, 3002, 3003]) {
    await syncOneZaicoItem(makeZaicoItem({ id, category: "家具", place: "倉庫A" }), "tester@example.com", undefined, port);
  }
  const createCalls = { ...calls };
  assertEqual(createCalls.findOrCreateCategory, 3, "前提: prefetch無しの初回作成では商品ごとにfindOrCreateCategoryが呼ばれる");

  // prefetched mapを渡さない(従来のadvanceZaicoBackgroundSyncJobの実際
  // にあったバグを再現)場合: 3件とも変更無しでもfindExistingBySourceId
  // が3回呼ばれ、masterCache無しなのでfindOrCreateCategory/Locationも
  // それぞれ3回追加で呼ばれる。
  const beforeFix = { ...calls };
  for (const id of [3001, 3002, 3003]) {
    await syncOneZaicoItem(makeZaicoItem({ id, category: "家具", place: "倉庫A" }), "tester@example.com", undefined, port);
  }
  assertEqual(calls.findExistingBySourceId - beforeFix.findExistingBySourceId, 3, "prefetch無し: 3件のunchanged再同期でfindExistingBySourceIdが3回呼ばれる(修正前の実装)");
  assertEqual(calls.findOrCreateCategory - beforeFix.findOrCreateCategory, 3, "prefetch無し: masterCache無しでは3件ともfindOrCreateCategoryを呼ぶ");

  // 修正後: 1ページ分としてprefetched map + masterCacheを1回だけ用意し、
  // 3件全てに使い回す。
  const prefetched = await port.fetchAllZaicoManaged();
  const masterCache = { categories: new Map<string, { id: string }>(), locations: new Map<string, { id: string }>() };
  const afterFixStart = { ...calls };
  for (const id of [3001, 3002, 3003]) {
    const result = await syncOneZaicoItem(makeZaicoItem({ id, category: "家具", place: "倉庫A" }), "tester@example.com", prefetched, port, masterCache);
    assertEqual(result.status, "unchanged", `修正後: id=${id}は正しくunchanged判定される(prefetch/cacheの有無が判定結果自体を変えない)`);
  }
  assertEqual(calls.findExistingBySourceId - afterFixStart.findExistingBySourceId, 0, "修正後: prefetched mapがあるのでfindExistingBySourceIdは1回も呼ばれない");
  assertEqual(calls.findOrCreateCategory - afterFixStart.findOrCreateCategory, 1, "修正後: masterCacheにより同じカテゴリ名の3件でfindOrCreateCategoryは初出の1回だけ");
  assertEqual(calls.findOrCreateLocation - afterFixStart.findOrCreateLocation, 1, "修正後: masterCacheにより同じ場所名の3件でfindOrCreateLocationは初出の1回だけ");
}

function testBackgroundJobPureHelpers() {
  assertEqual(Array.from(parseSeenSourceIds(["a", "b", "a", 3, null])).sort(), ["a", "b"], "parseSeenSourceIds dedups and drops non-string entries");
  assertEqual(Array.from(parseSeenSourceIds(undefined)), [], "parseSeenSourceIds tolerates a missing/undefined value");
  // 2026-08-29統合改修版 §6.4: 実際に報告された `Variable 'seenSourceIds'
  // has an invalid value.` の回帰テスト — 書き込み側が常にJSON文字列化
  // するようになった(stringifySeenSourceIds)後も、読み取り側がその
  // 文字列を正しく複合できることを確認する。
  assertEqual(Array.from(parseSeenSourceIds(JSON.stringify(["x", "y", "x"]))).sort(), ["x", "y"], "parseSeenSourceIds parses the JSON string form (what write side now always produces)");
  assertEqual(Array.from(parseSeenSourceIds("not valid json")), [], "parseSeenSourceIds degrades to empty on unparseable garbage instead of throwing");

  const job = toPublicJob({
    status: "RUNNING",
    lastPage: 3,
    totalProcessed: 120,
    created: 10,
    updated: 5,
    unchanged: 100,
    failed: 5,
    imageImported: 8,
    missingSourceIds: ["x", null, "y"],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    finishedAt: null,
    lastError: null,
    triggeredBy: "admin@example.com",
  });
  assertEqual(job.missingSourceIds, ["x", "y"], "toPublicJob filters out null entries from missingSourceIds");
  assertEqual(job.updatedAt, null, "toPublicJob defaults a missing optional field to null, not undefined");
  assertEqual(job.lastPage, 3, "toPublicJob passes through checkpoint fields unchanged");
}

function testPurchasePriceAllInCostRule() {
  // The exact regression case named in the master instructions:
  // sales=100000, purchasePrice=60000, legacy shippingCost=10000
  // → cost must be 60000 (purchasePrice only), profit must be 40000.
  // shippingCost must NEVER be re-added on top of purchasePrice.
  const summary = summarizeSales(
    [
      {
        id: "inv-1",
        displayId: "0001",
        sku: "SKU-0001",
        name: "テスト商品",
        saleEndDate: "2026-03-15",
        salePrice: 100000,
        purchasePrice: 60000,
        shippingCost: 10000,
      },
    ],
    2026,
    3,
  );
  assertEqual(summary.totalSales, 100000, "purchasePrice rule: totalSales");
  assertEqual(summary.totalCost, 60000, "purchasePrice rule: totalCost = purchasePrice only (shippingCost excluded)");
  assertEqual(summary.totalProfit, 40000, "purchasePrice rule: totalProfit = sales - purchasePrice-only cost");
}

// BELLO統合改修 master指示書(2026-08-29統合改修版) §20/§21 —
// 12ヶ月推移グラフの中央集計ロジック(summarizeMonthlyTrend)と、商品
// 単位の粗利益(calculateItemGrossProfit)。 ───────────────────────────

function testCalculateItemGrossProfit() {
  assertEqual(calculateItemGrossProfit(10000, 6000), 4000, "calculateItemGrossProfit: salePrice - purchasePrice");
  assertEqual(calculateItemGrossProfit(null, 6000), -6000, "calculateItemGrossProfit: treats a missing salePrice as 0");
  assertEqual(calculateItemGrossProfit(10000, null), 10000, "calculateItemGrossProfit: treats a missing purchasePrice as 0");
}

function testSummarizeMonthlyTrend() {
  const records = [
    { id: "a", displayId: "0001", sku: "SKU-0001", name: "3月商品", saleEndDate: "2026-03-10", salePrice: 5000, purchasePrice: 2000, shippingCost: 0 },
    { id: "b", displayId: "0002", sku: "SKU-0002", name: "1月商品", saleEndDate: "2026-01-05", salePrice: 3000, purchasePrice: 1000, shippingCost: 0 },
  ];
  const points = summarizeMonthlyTrend(records, 2026, 3, 12);
  assertEqual(points.length, 12, "summarizeMonthlyTrend: always returns exactly monthsBack points");
  assertEqual(points[points.length - 1], { year: 2026, month: 3, totalSales: 5000, totalGrossProfit: 3000 }, "summarizeMonthlyTrend: last point is the end month itself");
  assertEqual(points[9], { year: 2026, month: 1, totalSales: 3000, totalGrossProfit: 2000 }, "summarizeMonthlyTrend: an earlier month with real sales is included, not just the end month");
  // 実績が無い月(2026年2月)も0埋めで含まれる(欠番にならない) — spec:
  // 「実績が無い月も0として表示、月が飛ばない」。
  assertEqual(points[10], { year: 2026, month: 2, totalSales: 0, totalGrossProfit: 0 }, "summarizeMonthlyTrend: a month with zero matching sales is zero-filled, not skipped");
  // 年をまたぐ(2025年4月〜2026年3月の12ヶ月)ことも確認 — shiftYearMonth
  // 経由で年境界を正しく扱えているかの回帰確認。
  assertEqual(points[0], { year: 2025, month: 4, totalSales: 0, totalGrossProfit: 0 }, "summarizeMonthlyTrend: the oldest point correctly crosses the year boundary");
}

async function testThumbnailResize() {
  // A synthetic 1000×600 image (well past THUMBNAIL_MAX_DIMENSION on its
  // long edge) — sharp can synthesize raw pixel data directly, so this
  // needs no fixture file checked into the repo.
  const large = await sharp({ create: { width: 1000, height: 600, channels: 3, background: { r: 200, g: 80, b: 80 } } })
    .jpeg()
    .toBuffer();
  const resized = await resizeToThumbnailJpeg(large);
  const meta = await sharp(resized).metadata();
  assertTrue((meta.width ?? 0) <= THUMBNAIL_MAX_DIMENSION, "thumbnail resize: width is capped at THUMBNAIL_MAX_DIMENSION");
  assertTrue((meta.height ?? 0) <= THUMBNAIL_MAX_DIMENSION, "thumbnail resize: height is capped at THUMBNAIL_MAX_DIMENSION");
  assertEqual(meta.format, "jpeg", "thumbnail resize: output format is JPEG");
  assertTrue(resized.length < large.length, "thumbnail resize: output is smaller than the original (the whole point)");

  // A source already smaller than the cap must never be upscaled
  // (withoutEnlargement) — master指示書 Phase B優先度5 territory: don't
  // do wasted/harmful work on an image that's already small.
  const small = await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .jpeg()
    .toBuffer();
  const resizedSmall = await resizeToThumbnailJpeg(small);
  const smallMeta = await sharp(resizedSmall).metadata();
  assertEqual(smallMeta.width, 100, "thumbnail resize: a source already smaller than the cap is never upscaled (width)");
  assertEqual(smallMeta.height, 60, "thumbnail resize: a source already smaller than the cap is never upscaled (height)");
}

function testEffectiveListThumbnailKey() {
  const base: InventoryImageRecord = {
    storageKey: "inventory/original.jpg",
    sortOrder: 0,
    type: "NORMAL",
    isPrimary: true,
    sourceSystem: null,
    sourceUrl: null,
    thumbnailKey: null,
    originalHash: null,
    classification: null,
  };
  assertEqual(effectiveListThumbnailKey(base), "inventory/original.jpg", "effectiveListThumbnailKey: falls back to the original when no thumbnail exists (pre-backfill/failed generation)");
  assertEqual(
    effectiveListThumbnailKey({ ...base, thumbnailKey: "inventory/thumbnails/small.jpg" }),
    "inventory/thumbnails/small.jpg",
    "effectiveListThumbnailKey: uses the thumbnail when one exists",
  );
}

function testUpdatedAtSort() {
  // 2026-08-29統合改修版 §9の回帰テスト: 一覧デフォルトはupdatedAt DESC。
  const rows = [
    { id: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "b", updatedAt: "2026-03-01T00:00:00.000Z" },
    { id: "c", updatedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = [...rows].sort(compareByUpdatedAtDesc);
  assertEqual(sorted.map((r) => r.id), ["b", "c", "a"], "compareByUpdatedAtDesc: most recently updated first");

  const tie = [
    { id: "z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "y", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const sortedTie = [...tie].sort(compareByUpdatedAtDesc);
  assertEqual(sortedTie.map((r) => r.id), ["z", "y"], "compareByUpdatedAtDesc: a tie on updatedAt breaks stably by id, not arbitrarily");
}

async function main() {
  await testCreateThenIdempotentUnchanged();
  await testUpdateOnRealChange();
  await testFailureIsolation();
  await testClaimSourceLinkAtomicity();
  await testRaceDuringSingleItemSyncIsCaughtByClaim();
  await testRaceDuringBatchSyncIsCaughtByClaim();
  await testNumberStringIdBoundaryTreatedAsSameSource();
  await testRepeatedFullResyncNeverIncreasesCount();
  await testCreateFailureReleasesClaimForRetry();
  await testPrefetchAndMasterCacheAvoidRepeatedLookups();
  testBackgroundJobPureHelpers();
  testPurchasePriceAllInCostRule();
  testCalculateItemGrossProfit();
  testSummarizeMonthlyTrend();
  await testThumbnailResize();
  testEffectiveListThumbnailKey();
  testUpdatedAtSort();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-zaico-sync.ts crashed:", err);
  process.exit(1);
});

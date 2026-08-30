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
  let nextInventoryNum = 1;
  let nextSkuNum = 1;

  const calls = { createInventory: 0, updateInventory: 0, generateSku: 0 };

  const port: ZaicoSyncPort = {
    async findExistingBySourceId(sourceInventoryId) {
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
      if (categories.has(name)) return { id: categories.get(name)!, created: false };
      const id = `cat-${categories.size + 1}`;
      categories.set(name, id);
      return { id, created: true };
    },
    async findOrCreateLocation(name: string) {
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
      const id = `inv-${nextInventoryNum++}`;
      const record = { id, ...input } as unknown as InventoryModel;
      store.set(id, record);
      return record;
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

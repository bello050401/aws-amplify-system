/**
 * 販売価格(salePrice)の空欄補完が、実際の syncOneZaicoItem 経路(mock
 * ZaicoSyncPort境界)を通っても成立することの回帰テスト。
 *
 * ── なぜこのファイルが要るのか ──────────────────────────────────────
 *
 * scripts/verify-zaico-update-policy.ts は resolveFieldUpdate /
 * mergeZaicoUpdate という**純粋関数の層**だけを検証する。QAが実際に
 * 確認した不具合は「その層の判定結果が正しくても、syncOneZaicoItem が
 * それをport.updateInventoryへ渡す前の早期return・新規/既存判定・
 * スナップショット書き込みのどこかで消えていないか」まで含めて実処理
 * 経路で確認しないと「未検証」のままになる、というもの。
 *
 * `lib/inventory/zaicoSyncEngine.ts` は意図的に "server-only" を持たない
 * (ファイル冒頭コメント参照)ため、`with-server-only-stub.cjs`
 * (node_modules/server-only/index.jsを一時的に書き換えて実行するラッパー
 * ——他のタスク/セッションと共有される可能性のあるファイル)を経由せず
 * 直接 tsx で実行できる。このテストは「隔離された価格差分の検証」に
 * 徹する(指示書§5: 変更してよい範囲)ため、あえてこちらを使う。
 *
 * Run with: npm run verify:zaico-price-fill
 */
import { syncOneZaicoItem } from "@/lib/inventory/zaicoSyncEngine";
import type { ZaicoSyncPort, InventoryModel, NewInventoryInput, UpdateInventoryInput } from "@/lib/inventory/zaicoSyncPorts";
import type { HistoryFieldChange } from "@/lib/inventory/zaicoSyncEngine";
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

// ── in-memory mock ZaicoSyncPort ────────────────────────────────────────
// scripts/verify-zaico-sync.ts の createMockPort と同じ考え方の縮小版。
// 実DB/実AWSには一切触れない。
function createMockPort(seed: Partial<InventoryModel> & { id: string; sourceInventoryId: string }) {
  const store = new Map<string, InventoryModel>();
  store.set(seed.id, seed as InventoryModel);
  const updateCalls: UpdateInventoryInput[] = [];
  const historyLog: { inventoryId: string; who: string | null; changes: HistoryFieldChange[] }[] = [];

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
      return { id: `cat-${name}`, created: false };
    },
    async findOrCreateLocation(name: string) {
      return { id: `loc-${name}`, created: false };
    },
    async generateSku() {
      return "SKU-9999";
    },
    async createInventory(input: NewInventoryInput) {
      const record = { ...input } as unknown as InventoryModel;
      store.set(input.id, record);
      return record;
    },
    async claimSourceLink() {
      return { claimed: true };
    },
    async releaseSourceLink() {},
    async updateInventory(input: UpdateInventoryInput) {
      updateCalls.push(input);
      const existing = store.get(input.id);
      if (!existing) throw new Error(`mock: no such id ${input.id}`);
      store.set(input.id, { ...existing, ...input } as unknown as InventoryModel);
    },
    async logHistory(inventoryId, who, changes) {
      historyLog.push({ inventoryId, who, changes });
    },
    async downloadAndImportImage(url: string) {
      return { storageKey: `mock/${url}`, thumbnailKey: null, originalHash: `hash/${url}` };
    },
    async removeImage() {},
  };

  return { port, store, updateCalls, historyLog };
}

function makeZaicoItem(overrides: Partial<ZaicoInventory> = {}): ZaicoInventory {
  return {
    id: 42001,
    title: "テストソファ",
    quantity: 1,
    unit: "点",
    category: "家具",
    place: "倉庫A",
    etc: null,
    code: null,
    item_image: null,
    optional_attributes: [{ name: "⚫︎販売価格", value: "24800" }],
    ...overrides,
  } as ZaicoInventory;
}

/** 既存在庫: salePrice が空欄(null)、名前・数量などは既にZAICOと一致させておく
 *  (salePrice「だけ」が差分になる境界を作るため)。 */
function makeExistingRecord(overrides: Partial<InventoryModel> = {}): InventoryModel & { sourceInventoryId: string } {
  return {
    id: "inv-1",
    sku: "SKU-0001",
    name: "テストソファ",
    categoryId: null,
    locationId: null,
    quantity: 1,
    unit: "点",
    note: null,
    barcode: null,
    purchasePrice: null,
    salePrice: null,
    images: [],
    customFields: null,
    sourceSystem: "ZAICO",
    sourceInventoryId: "42001",
    zaicoSnapshotJson: null,
    deletedAt: null,
    ...overrides,
  } as unknown as InventoryModel & { sourceInventoryId: string };
}

/* 1. 既存空欄 + 有効なZAICO価格 → 実syncOne経路でport.updateInventoryのsalePriceに入る */
async function testBlankSalePriceFilledThroughRealSyncPath() {
  const existing = makeExistingRecord();
  const { port, store, updateCalls } = createMockPort(existing);

  const result = await syncOneZaicoItem(makeZaicoItem(), "tester@example.com", undefined, port);

  assertEqual(result.status, "updated", "実syncOne経路: 既存空欄+有効ZAICO価格はupdatedになる(unchangedの早期returnを通り抜けている)");
  assertEqual(updateCalls.length, 1, "実syncOne経路: updateInventoryが1回呼ばれる");
  assertEqual(updateCalls[0]?.salePrice, 24800, "実syncOne経路: update入力のsalePriceにZAICO値が入る");
  assertEqual(store.get("inv-1")?.salePrice, 24800, "実syncOne経路: mock在庫のsalePriceが実際に補完される");
  assertTrue(!result.warnings.some((w) => w.includes("販売価格")), "実syncOne経路: 空欄補完はwarningsに出さない(食い違いではないため)");
}

/* 2. ZAICOが0円を返す場合も(0は空欄ではないので)補完される */
async function testZeroSalePriceFilledThroughRealSyncPath() {
  const existing = makeExistingRecord();
  const { port, store, updateCalls } = createMockPort(existing);

  const result = await syncOneZaicoItem(
    makeZaicoItem({ optional_attributes: [{ name: "⚫︎販売価格", value: "0" }] }),
    "tester@example.com",
    undefined,
    port,
  );

  assertEqual(result.status, "updated", "実syncOne経路: ZAICOの0円でも既存空欄なら反映される");
  assertEqual(updateCalls[0]?.salePrice, 0, "実syncOne経路: update入力のsalePriceは0(空欄扱いされていない)");
  assertEqual(store.get("inv-1")?.salePrice, 0, "実syncOne経路: mock在庫のsalePriceが0になる");
}

/* 3. 既存に値があって食い違う場合は、実経路でも書き込まず、警告として報告される */
async function testExistingNonEmptyConflictIsNotOverwritten() {
  const existing = makeExistingRecord({ salePrice: 46222, zaicoSnapshotJson: JSON.stringify({ salePrice: 46220 }) });
  const { port, store, updateCalls } = createMockPort(existing);

  const result = await syncOneZaicoItem(
    makeZaicoItem({ optional_attributes: [{ name: "⚫︎販売価格", value: "46220" }] }),
    "tester@example.com",
    undefined,
    port,
  );

  // salePrice以外に差分が無いので、更新自体は「販売価格の食い違いを報告する
  // ためだけ」に走る(quantityやnameは一致させてある)。
  assertEqual(store.get("inv-1")?.salePrice, 46222, "実syncOne経路: 既存の非空値はCONFLICTでも上書きされない");
  assertTrue(
    result.warnings.some((w) => w.includes("販売価格") && w.includes("食い違って")),
    "実syncOne経路: 既存非空の食い違いはwarningsに報告される",
  );
  if (updateCalls.length > 0) {
    assertEqual(updateCalls[0]?.salePrice, undefined, "実syncOne経路: 食い違いはupdate入力のsalePriceに含まれない");
  }
}

/* 4. ZAICO側が空(optional_attributesに販売価格が無い)なら、既存空欄のままで消さない・書き込まない */
async function testZaicoMissingSalePriceDoesNotTouchBlank() {
  const existing = makeExistingRecord({ quantity: 1 });
  const { port, store, updateCalls } = createMockPort(existing);

  // ZAICO側の数量だけ変えて、salePriceのoptional_attribute自体を含めない
  // (=ZAICOがこの項目について何も言っていない状態)。
  const result = await syncOneZaicoItem(
    makeZaicoItem({ quantity: 2, optional_attributes: [] }),
    "tester@example.com",
    undefined,
    port,
  );

  assertEqual(result.status, "updated", "実syncOne経路: 他項目の変更で更新は走る");
  assertEqual(store.get("inv-1")?.salePrice, null, "実syncOne経路: ZAICOが販売価格に触れなければ空欄のまま");
  assertEqual(updateCalls[0]?.salePrice, undefined, "実syncOne経路: update入力にsalePriceは含まれない");
}

/* 5. 補完直後に同じZAICO値で同期を再実行しても、2回目はunchanged(再書き込みしない・warningsも出ない) */
async function testRerunAfterFillIsUnchanged() {
  const existing = makeExistingRecord();
  const { port, store, updateCalls } = createMockPort(existing);

  const first = await syncOneZaicoItem(makeZaicoItem(), "tester@example.com", undefined, port);
  assertEqual(first.status, "updated", "同期再実行: 1回目は補完でupdatedになる");
  assertEqual(store.get("inv-1")?.salePrice, 24800, "同期再実行: 1回目でsalePriceが入る");
  assertTrue(typeof store.get("inv-1")?.zaicoSnapshotJson === "string", "同期再実行: 1回目でスナップショットが書かれる");

  const second = await syncOneZaicoItem(makeZaicoItem(), "tester@example.com", undefined, port);
  assertEqual(second.status, "unchanged", "同期再実行: 2回目はunchanged(既存早期returnを通る)");
  assertEqual(updateCalls.length, 1, "同期再実行: 2回目はupdateInventoryを呼ばない");
  assertEqual(second.warnings.length, 0, "同期再実行: 2回目はwarningsも出ない");
}

/* 6. 新規作成(BELLOにまだ無いZAICO商品)では、これまでどおりZAICOの価格がそのまま入る */
async function testNewRecordGetsSalePriceDirectly() {
  const { port, store } = createMockPort(makeExistingRecord({ id: "other", sourceInventoryId: "99999" }));

  const result = await syncOneZaicoItem(makeZaicoItem({ id: 55001 }), "tester@example.com", undefined, port);

  assertEqual(result.status, "created", "新規作成: ZAICOにしか無い商品はcreatedになる");
  const created = [...store.values()].find((v) => v.sourceInventoryId === "55001");
  assertEqual(created?.salePrice, 24800, "新規作成: salePriceがZAICOの値でそのまま入る");
}

async function main() {
  await testBlankSalePriceFilledThroughRealSyncPath();
  await testZeroSalePriceFilledThroughRealSyncPath();
  await testExistingNonEmptyConflictIsNotOverwritten();
  await testZaicoMissingSalePriceDoesNotTouchBlank();
  await testRerunAfterFillIsUnchanged();
  await testNewRecordGetsSalePriceDirectly();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();

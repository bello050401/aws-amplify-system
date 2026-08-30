/**
 * BELLO統合業務OS ZAICO級高速化仕様書 §30.1/§30.2/§30.3: ZAICO同期の
 * baseline計測 + 改善後再計測ハーネス。
 *
 * 【計測方式について、正直に】このサンドボックスには実ZAICO APIも実
 * AWS(DynamoDB)アクセスも無い(第三ラウンド報告の根本原因参照)。その
 * ため本ハーネスは、実際の同期ロジック(lib/inventory/zaicoSync.tsの
 * `syncOneZaicoItem` — 本番と全く同じコード、一切複製しない)を、
 * 実DynamoDB/S3の代わりに「操作種別ごとの遅延モデル」を持つ
 * in-memory mock port経由で駆動する。遅延モデルの数値(下記
 * SIMULATED_LATENCY_MS)は実測DynamoDB/S3の値ではなく、公開されている
 * 一般的なオーダー感(単純なGetItem/PutItemは数ms、Scanは対象件数に
 * 比例して増加する等)を根拠にした仮定値であり、そのように明記する
 * ("シミュレーション値"であって"実測値"ではない)。テストしているのは
 * 「アルゴリズムが件数に対してどうスケールするか」(O(N²)的な設計か
 * O(N)的な設計か)であり、絶対的なミリ秒値の精度を主張しない。
 *
 * 実AWS認証が復旧した場合は、この同じベンチマーク構造をStaging上の
 * 実CloudWatch/DynamoDB計測に置き換えて再実行できる(このファイルの
 * ケース定義・メトリクス集計ロジックはそのまま再利用可能)。
 *
 * Run with: npm run benchmark:zaico-sync
 */
import { syncOneZaicoItem } from "@/lib/inventory/zaicoSync";
import type { ZaicoSyncPort, InventoryModel, NewInventoryInput, UpdateInventoryInput, MasterCache } from "@/lib/inventory/zaicoSyncPorts";
import type { HistoryFieldChange } from "@/lib/inventory/history";
import type { ZaicoInventory } from "@/lib/zaico/client";

// ── シミュレーション遅延モデル(§30.2の根拠として明記) ──────────────
// 単位: ms。「操作1回あたりの基礎コスト」+「対象件数に比例するコスト」
// の合計としてモデル化する — DynamoDBのGetItem/PutItemはO(1)、Scanは
// 読み取った件数に比例してRCU消費・latencyが増える、という一般的な
// 特性をこの2パラメータで表現する。
const SIM = {
  dbOpBaseMs: 4, // GetItem/PutItem/UpdateItem 1回の基礎往復コスト
  dbScanPerRowMs: 0.02, // Scanが実際に読み取った1行あたりの追加コスト
  imageDownloadMs: 140, // 画像ダウンロード+アップロード+thumbnail生成(sharp)
  checkpointWriteMs: 6, // ZaicoSyncJobチェックポイント1回分のUpdateItem
};

interface SimResult {
  elapsedMs: number;
  dbReads: number;
  dbWrites: number;
  dbReadMs: number;
  dbWriteMs: number;
  imageChecked: number;
  imageDownloaded: number;
  imageMs: number;
  checkpointWrites: number;
  checkpointMs: number;
  comparisonMs: number;
  otherMs: number;
  itemsScanned: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

function newSimResult(): SimResult {
  return {
    elapsedMs: 0,
    dbReads: 0,
    dbWrites: 0,
    dbReadMs: 0,
    dbWriteMs: 0,
    imageChecked: 0,
    imageDownloaded: 0,
    imageMs: 0,
    checkpointWrites: 0,
    checkpointMs: 0,
    comparisonMs: 0,
    otherMs: 0,
    itemsScanned: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
  };
}

/**
 * 実装(lib/inventory/zaicoSyncPorts.tsのcreateServerSyncPort)と全く
 * 同じ「どの操作がDB read/writeか」の構造を持つmock port。ただし
 * 実データの代わりにMapを使い、各呼び出しへ`SIM`の遅延モデルに基づく
 * 仮想時間をsimクロックへ加算する(実wall-clock sleepは行わない —
 * 1000件規模のケースを何度も走らせるベンチマークが現実的な時間で
 * 終わるようにするため。これは「アルゴリズムのスケーリング特性」を
 * 測るのが目的であるため許容される、との判断——本ファイル冒頭コメント
 * 参照)。
 */
function createBenchmarkPort(existingCount: number, masterCategoryCount: number, masterLocationCount: number) {
  const store = new Map<string, InventoryModel & { sourceInventoryId: string }>();
  const categories = new Map<string, string>();
  const locations = new Map<string, string>();
  let nextId = 1;
  let nextSku = 1;

  for (let i = 0; i < masterCategoryCount; i++) categories.set(`カテゴリ${i}`, `cat-${i}`);
  for (let i = 0; i < masterLocationCount; i++) locations.set(`場所${i}`, `loc-${i}`);

  for (let i = 0; i < existingCount; i++) {
    const id = `inv-${nextId++}`;
    const sourceInventoryId = String(1000 + i);
    store.set(id, {
      id,
      sku: `SKU-${String(nextSku++).padStart(5, "0")}`,
      name: `商品${sourceInventoryId}`, // makeZaicoItemのtitle(`商品${sourceInventoryId}`)と一致させる — 不一致だと「変更なし」ケースが誤ってupdated扱いになる(このベンチマーク作成時に発見・修正した既知の落とし穴)。
      categoryId: "cat-0",
      locationId: "loc-0",
      quantity: 1,
      unit: "個",
      purchasePrice: 1000,
      salePrice: 2000,
      note: null,
      barcode: null,
      images: [],
      customFields: null,
      createdBy: "bench",
      updatedBy: "bench",
      sourceSystem: "ZAICO",
      sourceInventoryId,
      deletedAt: null,
    } as unknown as InventoryModel & { sourceInventoryId: string });
  }

  const sim = newSimResult();

  const port: ZaicoSyncPort = {
    async findExistingBySourceId(sourceInventoryId) {
      sim.dbReads++;
      // 実装通り: Scan相当 — テーブル全件を読み取ってfilterする
      // (amplify/data/resource.tsにsourceInventoryIdのGSIが無いため、
      // .list({filter})はAmplify DataではFilterExpression付きScanになる
      // — この計測ハーネス自体が今回発見した根本原因を再現している)。
      const rows = Array.from(store.values());
      sim.dbReadMs += SIM.dbOpBaseMs + rows.length * SIM.dbScanPerRowMs;
      return rows.find((v) => v.sourceInventoryId === sourceInventoryId && !v.deletedAt) ?? null;
    },
    async fetchAllZaicoManaged() {
      sim.dbReads++;
      const rows = Array.from(store.values()).filter((v) => v.sourceSystem === "ZAICO" && !v.deletedAt);
      sim.dbReadMs += SIM.dbOpBaseMs + rows.length * SIM.dbScanPerRowMs;
      const map = new Map<string, InventoryModel>();
      for (const v of rows) map.set(v.sourceInventoryId, v);
      return map;
    },
    async findOrCreateCategory(name: string) {
      sim.dbReads++;
      // listAllMasterEntries("Category")相当 — マスタ全件を毎回取得
      sim.dbReadMs += SIM.dbOpBaseMs + categories.size * SIM.dbScanPerRowMs;
      if (categories.has(name)) return { id: categories.get(name)!, created: false };
      sim.dbWrites++;
      sim.dbWriteMs += SIM.dbOpBaseMs;
      const id = `cat-new-${categories.size + 1}`;
      categories.set(name, id);
      return { id, created: true };
    },
    async findOrCreateLocation(name: string) {
      sim.dbReads++;
      sim.dbReadMs += SIM.dbOpBaseMs + locations.size * SIM.dbScanPerRowMs;
      if (locations.has(name)) return { id: locations.get(name)!, created: false };
      sim.dbWrites++;
      sim.dbWriteMs += SIM.dbOpBaseMs;
      const id = `loc-new-${locations.size + 1}`;
      locations.set(name, id);
      return { id, created: true };
    },
    async generateSku() {
      sim.dbWrites++;
      sim.dbWriteMs += SIM.dbOpBaseMs;
      return `SKU-${String(nextSku++).padStart(5, "0")}`;
    },
    async createInventory(input: NewInventoryInput) {
      sim.dbWrites++;
      sim.dbWriteMs += SIM.dbOpBaseMs;
      const id = `inv-${nextId++}`;
      const record = { id, ...input } as unknown as InventoryModel;
      store.set(id, record as InventoryModel & { sourceInventoryId: string });
      return record;
    },
    async updateInventory(input: UpdateInventoryInput) {
      sim.dbWrites++;
      sim.dbWriteMs += SIM.dbOpBaseMs;
      const existing = store.get(input.id);
      if (!existing) throw new Error(`benchmark: no such id ${input.id}`);
      store.set(input.id, { ...existing, ...input } as InventoryModel & { sourceInventoryId: string });
    },
    async logHistory() {
      sim.dbWrites++;
      sim.dbWriteMs += SIM.dbOpBaseMs;
    },
    async downloadAndImportImage(url: string) {
      sim.imageDownloaded++;
      sim.imageMs += SIM.imageDownloadMs;
      return { storageKey: `bench/${url}`, thumbnailKey: `bench/thumb/${url}`, originalHash: `bench-hash/${url}` };
    },
    async removeImage() {
      sim.dbWrites++;
      sim.dbWriteMs += SIM.dbOpBaseMs;
    },
  };

  return { port, sim, store };
}

function makeZaicoItem(sourceInventoryId: string, overrides: Partial<ZaicoInventory> = {}): ZaicoInventory {
  return {
    id: Number(sourceInventoryId),
    title: `商品${sourceInventoryId}`,
    quantity: 1,
    unit: "個",
    category: "カテゴリ0",
    place: "場所0",
    etc: null,
    code: null,
    item_image: null,
    optional_attributes: [],
    ...overrides,
  };
}

interface CaseSpec {
  name: string;
  existingCount: number;
  buildItems: () => ZaicoInventory[];
}

const CASES: CaseSpec[] = [
  { name: "A: 既存100件・変更0件", existingCount: 100, buildItems: () => Array.from({ length: 100 }, (_, i) => makeZaicoItem(String(1000 + i))) },
  { name: "B: 既存300件・変更0件", existingCount: 300, buildItems: () => Array.from({ length: 300 }, (_, i) => makeZaicoItem(String(1000 + i))) },
  { name: "C: 既存1000件・変更0件", existingCount: 1000, buildItems: () => Array.from({ length: 1000 }, (_, i) => makeZaicoItem(String(1000 + i))) },
  {
    name: "D: 既存990件＋新規10件",
    existingCount: 990,
    buildItems: () => [
      ...Array.from({ length: 990 }, (_, i) => makeZaicoItem(String(1000 + i))),
      ...Array.from({ length: 10 }, (_, i) => makeZaicoItem(String(9000 + i))),
    ],
  },
  {
    name: "E: 既存990件＋更新10件",
    existingCount: 1000,
    buildItems: () => [
      ...Array.from({ length: 990 }, (_, i) => makeZaicoItem(String(1000 + i))),
      ...Array.from({ length: 10 }, (_, i) => makeZaicoItem(String(1990 + i), { quantity: 999 })), // 数量変更
    ],
  },
  {
    name: "F: 画像のみ変更10件",
    existingCount: 1000,
    buildItems: () => [
      ...Array.from({ length: 990 }, (_, i) => makeZaicoItem(String(1000 + i))),
      ...Array.from({ length: 10 }, (_, i) => makeZaicoItem(String(1990 + i), { item_image: { url: `https://example.com/new-${i}.jpg` } })),
    ],
  },
];

/** §30.7の修正版で使うmasterCache。fetchAllZaicoManagedのmapと同じ「1回だけprefetchし、以降はO(1)ルックアップ」パターンをCategory/Locationにも適用する。 */
function buildEmptyMasterCache(): MasterCache {
  return { categories: new Map(), locations: new Map() };
}

/**
 * 1ページ(ITEMS_PER_ADVANCE=50件相当)ずつsyncOneZaicoItemを呼ぶ、
 * advanceZaicoBackgroundSyncJobの実際のループ構造を再現したドライバ。
 * `useFix`がfalseなら現行実装と全く同じ「prefetch無し・毎回port経由」
 * (advanceZaicoBackgroundSyncJobが実際にsyncOneZaicoItemへ`undefined`
 * を渡している、というこのラウンドで発見した実装をそのまま再現)。
 * trueならfetchAllZaicoManaged+masterCacheをページ毎に1回prefetchする
 * (このラウンドで実装した修正)。
 */
async function runSyncDriver(port: ZaicoSyncPort, items: ZaicoInventory[], useFix: boolean, checkpointSim: SimResult) {
  const PAGE_SIZE = 50;
  const results: Awaited<ReturnType<typeof syncOneZaicoItem>>[] = [];
  for (let pageStart = 0; pageStart < items.length; pageStart += PAGE_SIZE) {
    const page = items.slice(pageStart, pageStart + PAGE_SIZE);
    const prefetched = useFix ? await port.fetchAllZaicoManaged() : undefined;
    const masterCache = useFix ? buildEmptyMasterCache() : undefined;
    for (const item of page) {
      results.push(await syncOneZaicoItem(item, "benchmark", prefetched, port, masterCache));
    }
    // advanceZaicoBackgroundSyncJobは1ページごとに1回チェックポイント
    // (ZaicoSyncJob.update)を書く。
    checkpointSim.checkpointWrites++;
    checkpointSim.checkpointMs += SIM.checkpointWriteMs;
  }
  return results;
}

interface CaseReport {
  name: string;
  useFix: boolean;
  elapsedMs: number;
  itemsScanned: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  dbReads: number;
  dbWrites: number;
  imageDownloaded: number;
  dbReadMs: number;
  dbWriteMs: number;
  imageMs: number;
  checkpointMs: number;
  checkpointWrites: number;
  itemsPerSec: number;
}

async function runCase(spec: CaseSpec, useFix: boolean): Promise<CaseReport> {
  const { port, sim } = createBenchmarkPort(spec.existingCount, 10, 5);
  const items = spec.buildItems();

  const wallStart = performance.now();
  const results = await runSyncDriver(port, items, useFix, sim);
  const wallElapsed = performance.now() - wallStart; // 実コード実行のオーバーヘッド(分岐・diff計算等) — 通常は非常に小さい

  const totalSimMs = sim.dbReadMs + sim.dbWriteMs + sim.imageMs + sim.checkpointMs;

  return {
    name: spec.name,
    useFix,
    elapsedMs: Math.round((totalSimMs + wallElapsed) * 100) / 100,
    itemsScanned: results.length,
    created: results.filter((r) => r.status === "created").length,
    updated: results.filter((r) => r.status === "updated").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    failed: results.filter((r) => r.status === "failed").length,
    dbReads: sim.dbReads,
    dbWrites: sim.dbWrites,
    imageDownloaded: sim.imageDownloaded,
    dbReadMs: Math.round(sim.dbReadMs * 100) / 100,
    dbWriteMs: Math.round(sim.dbWriteMs * 100) / 100,
    imageMs: Math.round(sim.imageMs * 100) / 100,
    checkpointMs: Math.round(sim.checkpointMs * 100) / 100,
    checkpointWrites: sim.checkpointWrites,
    itemsPerSec: Math.round((results.length / ((totalSimMs + wallElapsed) / 1000)) * 100) / 100,
  };
}

/** §30.3ケースG: checkpoint resume — 1000件を2回に分けてadvanceし(500件ずつ)、2回目の呼び出しが1回目で処理済みの500件を再処理しないことを確認する。 */
async function runResumeCase(useFix: boolean): Promise<{ firstHalfDbReads: number; secondHalfDbReads: number; secondHalfReprocessedFirstHalf: boolean }> {
  const { port, sim } = createBenchmarkPort(0, 10, 5);
  const allItems = Array.from({ length: 1000 }, (_, i) => makeZaicoItem(String(1000 + i)));
  const firstHalf = allItems.slice(0, 500);
  const secondHalf = allItems.slice(500);

  await runSyncDriver(port, firstHalf, useFix, sim);
  const dbReadsAfterFirst = sim.dbReads;

  // 2回目の呼び出し(resume) — 1回目のfirstHalfは一切渡さない
  // (checkpointが「次はpage11から」を覚えている、という実装を模倣)。
  const secondResults = await runSyncDriver(port, secondHalf, useFix, sim);
  const dbReadsSecondHalf = sim.dbReads - dbReadsAfterFirst;

  // secondHalfの結果に firstHalf の商品(sourceInventoryId 1000-1499)が
  // 含まれていないことを確認 — resumeが重複処理していない証拠。
  const secondHalfIds = new Set(secondResults.map((r) => r.zaicoId));
  const reprocessed = firstHalf.some((item) => secondHalfIds.has(String(item.id)));

  return { firstHalfDbReads: dbReadsAfterFirst, secondHalfDbReads: dbReadsSecondHalf, secondHalfReprocessedFirstHalf: reprocessed };
}

function formatTable(rows: CaseReport[]): string {
  const header = "| ケース | dbReads | dbWrites | imageDL | dbReadMs | dbWriteMs | imageMs | checkpointMs | 合計elapsedMs(シミュレーション) | items/sec |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map(
    (r) =>
      `| ${r.name} | ${r.dbReads} | ${r.dbWrites} | ${r.imageDownloaded} | ${r.dbReadMs} | ${r.dbWriteMs} | ${r.imageMs} | ${r.checkpointMs} | ${r.elapsedMs} | ${r.itemsPerSec} |`,
  );
  return [header, sep, ...lines].join("\n");
}

async function main() {
  const mode = process.argv[2] === "--fixed" ? true : process.argv[2] === "--before" ? false : null;
  if (mode === null) {
    console.error("Usage: benchmark-zaico-sync.ts --before | --fixed");
    process.exit(1);
  }

  console.log(`\n=== ZAICO同期ベンチマーク (${mode ? "修正後(prefetch+masterCache)" : "現行(advanceZaicoBackgroundSyncJobの実装通り、prefetch無し)"}) ===\n`);

  const reports: CaseReport[] = [];
  for (const spec of CASES) {
    const r = await runCase(spec, mode);
    reports.push(r);
    console.log(
      `${r.name}: itemsScanned=${r.itemsScanned} created=${r.created} updated=${r.updated} unchanged=${r.unchanged} failed=${r.failed} ` +
        `dbReads=${r.dbReads} dbWrites=${r.dbWrites} imageDL=${r.imageDownloaded} elapsedMs=${r.elapsedMs} items/sec=${r.itemsPerSec}`,
    );
  }

  console.log("\n" + formatTable(reports) + "\n");

  console.log("=== ケースG: checkpoint resume (1000件を500件ずつ2回に分けて処理) ===");
  const resume = await runResumeCase(mode);
  console.log(
    `1回目(500件)dbReads=${resume.firstHalfDbReads} / 2回目(500件、resume)dbReads=${resume.secondHalfDbReads} / ` +
      `2回目が1回目分を再処理=${resume.secondHalfReprocessedFirstHalf}`,
  );

  console.log(`\n${JSON.stringify({ mode: mode ? "fixed" : "before", reports, resume }, null, 2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

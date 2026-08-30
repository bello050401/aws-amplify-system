/**
 * BELLO統合業務OS 第五ラウンド §7/§43(P0-C): Inventory一覧/検索/詳細の
 * 性能baseline測定。
 *
 * 【正直な方法論の明記——scripts/benchmark-zaico-sync.tsと同じ方針】
 * この環境には実AWS認証情報が無く、実AppSync/DynamoDBへ到達できない
 * ため、ここで測定しているのは「実際のミリ秒値」ではなく「実際の
 * アルゴリズム(lib/inventory/queries.tsの
 * fetchAllInventoryRecords/listInventory/listInventorySimpleSearch/
 * listInventoryAdvanced/getInventoryDetailと全く同じ形の処理——
 * ページング回数・全件取得の有無・ソート/フィルタがどこで行われるか)
 * が件数に対してどうスケールするかである。1回のAppSync GraphQL呼び出し
 * あたりの遅延は、根拠のある実測値ではなく**明記した仮定値**
 * (`SIM.appsyncCallMs`)を使う——この値そのものの精度は主張しない。
 * 「実際のAWS/AppSyncの速度が数値通り」という主張は一切行わない。
 *
 * 測定しているのはアルゴリズムの形——例えば「一覧の次ページ/戻るが、
 * 初回一覧と全く同じ全件再取得コストを毎回払う」という設計上の事実
 * ——であり、この事実はAppSyncの実測ms値が変わっても変わらない。
 *
 * 実行: npm run benchmark:inventory-queries
 */

// ────────────────────────────────────────────────────────────────────
// SIM: 明記された仮定値(実測ではない)
// ────────────────────────────────────────────────────────────────────
const SIM = {
  // 同一リージョン内のAppSync GraphQLクエリ1回あたりの往復遅延の仮定値。
  // 根拠: 一般的なAppSync+DynamoDB構成で報告される目安レンジ
  // (数十〜100ms程度)の中央値を採用しただけで、このリポジトリの実際の
  // AWS環境で計測した値ではない。
  appsyncCallMs: 70,
  appsyncJitterMs: 30,
  // 1レコードをJS側でシリアライズ/正規化(toSearchRecord相当)する
  // コストの仮定値。実測ではないが、フィールド数十個程度のオブジェクト
  // 生成は数十μs〜低ms程度という一般的なV8の挙動を踏まえた保守的な値。
  perRecordMapMs: 0.01,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function simulatedNetworkDelay(): Promise<void> {
  return sleep(SIM.appsyncCallMs + Math.random() * SIM.appsyncJitterMs);
}

// ────────────────────────────────────────────────────────────────────
// lib/inventory/queries.tsの純粋な比較関数(重複させず本体を直接import
// できないのは、そのファイルが`import "server-only"` + `serverDataClient`
// (next/headersのcookies()に依存、Next.jsのリクエストコンテキスト外
// では呼び出し時にthrowする)を直接importしているため——
// scripts/verify-*.tsと同じ「小さな純粋ロジックの複製」方針に従う。
// ────────────────────────────────────────────────────────────────────
interface MinimalRow {
  id: string;
  updatedAt: string;
}
function compareByUpdatedAtDesc(a: MinimalRow, b: MinimalRow): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

// ────────────────────────────────────────────────────────────────────
// モックInventoryテーブル(in-memory)。実際のfetchAllInventoryRecordsと
// 全く同じ形——200件/pageのnextTokenループ、20000件安全弁、
// updatedAt DESCソート——を、モックのAppSync呼び出しに対して行う。
// ────────────────────────────────────────────────────────────────────
interface MockRecord extends MinimalRow {
  sku: string;
  name: string;
  categoryId: string | null;
  locationId: string | null;
}

function makeTable(size: number): MockRecord[] {
  const categories = ["cat-A", "cat-B", "cat-C", "cat-D"];
  const rows: MockRecord[] = [];
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < size; i++) {
    rows.push({
      id: `inv-${i}`,
      sku: `B${String(i).padStart(6, "0")}`,
      name: `商品${i}`,
      categoryId: categories[i % categories.length],
      locationId: `loc-${i % 10}`,
      updatedAt: new Date(base + i * 1000).toISOString(),
    });
  }
  return rows;
}

const PAGE_SIZE = 200;
const SEARCH_MAX_SCAN_ITEMS = 20000;

/** 実際のInventory.list({filter, limit, nextToken})呼び出しのモック——DynamoDBレベルのfilter pushdown(categoryId等)は実際に効かせる。 */
async function mockListCall(
  table: MockRecord[],
  filter: (r: MockRecord) => boolean,
  cursor: number,
  limit: number,
): Promise<{ items: MockRecord[]; nextCursor: number | null }> {
  await simulatedNetworkDelay();
  const matched: MockRecord[] = [];
  let i = cursor;
  // 実DynamoDBの挙動を模す: 1回のfilter付きlist呼び出しは「1ページ分の
  // 物理scan行数(=limit)」だけを見てその中からfilter一致行を返す
  // ——一致件数がlimit未満でも、次のnextTokenで続きから再開する。
  const scanEnd = Math.min(i + limit, table.length);
  for (; i < scanEnd; i++) {
    if (filter(table[i])) matched.push(table[i]);
  }
  const nextCursor = i < table.length ? i : null;
  return { items: matched, nextCursor };
}

/** lib/inventory/queries.tsのfetchAllInventoryRecordsと同じ形。 */
async function fetchAllInventoryRecordsSim(table: MockRecord[], extraFilter: (r: MockRecord) => boolean = () => true): Promise<{ rows: MockRecord[]; calls: number }> {
  const items: MockRecord[] = [];
  let cursor = 0;
  let calls = 0;
  do {
    const { items: page, nextCursor } = await mockListCall(table, extraFilter, cursor, PAGE_SIZE);
    calls++;
    items.push(...page);
    // toSearchRecord相当のマッピングコスト
    await sleep(page.length * SIM.perRecordMapMs);
    if (nextCursor === null) break;
    cursor = nextCursor;
    if (items.length >= SEARCH_MAX_SCAN_ITEMS) break;
  } while (cursor < table.length);
  items.sort(compareByUpdatedAtDesc);
  return { rows: items, calls };
}

async function simListInventory(table: MockRecord[], offset: number, limit: number): Promise<{ elapsedMs: number; calls: number; total: number }> {
  const t0 = performance.now();
  const { rows, calls } = await fetchAllInventoryRecordsSim(table);
  const total = rows.length;
  void rows.slice(offset, offset + limit);
  return { elapsedMs: performance.now() - t0, calls, total };
}

async function simQuickSearch(table: MockRecord[], q: string): Promise<{ elapsedMs: number; calls: number; matched: number }> {
  const t0 = performance.now();
  const { rows, calls } = await fetchAllInventoryRecordsSim(table);
  const filtered = rows.filter((r) => r.name.includes(q) || r.sku.includes(q));
  return { elapsedMs: performance.now() - t0, calls, matched: filtered.length };
}

async function simAdvancedSearch(table: MockRecord[], categoryId: string, locationId: string): Promise<{ elapsedMs: number; calls: number; matched: number }> {
  const t0 = performance.now();
  const { rows, calls } = await fetchAllInventoryRecordsSim(table);
  // AND/OR混在の詳細検索はDynamoDB filterに委譲できないため常に
  // アプリ側判定——実装通り、DynamoDB側filterは一切渡さない。
  const filtered = rows.filter((r) => (r.categoryId === categoryId) || (r.locationId === locationId));
  return { elapsedMs: performance.now() - t0, calls, matched: filtered.length };
}

/**
 * 商品詳細ページ: Inventory.get()(単一get、常にO(1)) +
 * InventoryHistory(第五ラウンドP0-Bで実GSI Query化済み、対象商品の
 * 履歴行だけを読む——テーブル全体には比例しない)。
 */
async function simGetInventoryDetail(historyRowsForThisItem: number): Promise<{ elapsedMs: number }> {
  const t0 = performance.now();
  await simulatedNetworkDelay(); // Inventory.get()
  await simulatedNetworkDelay(); // InventoryHistory GSI Query(1回、対象商品分だけ)
  await sleep(historyRowsForThisItem * SIM.perRecordMapMs);
  return { elapsedMs: performance.now() - t0 };
}

// ────────────────────────────────────────────────────────────────────
// p50/p95計算 + SLO判定
// ────────────────────────────────────────────────────────────────────
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

interface SloCheck {
  op: string;
  p50: number;
  p95: number;
  sloP50: number;
  sloP95: number;
}

function checkSlo(rows: SloCheck[]): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    const p50ok = r.p50 <= r.sloP50;
    const p95ok = r.p95 <= r.sloP95;
    lines.push(
      `  ${p50ok && p95ok ? "✓" : "✗"} ${r.op}: p50=${r.p50.toFixed(1)}ms(SLO ${r.sloP50}ms ${p50ok ? "OK" : "NG"}) / p95=${r.p95.toFixed(1)}ms(SLO ${r.sloP95}ms ${p95ok ? "OK" : "NG"})`,
    );
  }
  return lines;
}

/**
 * 試行回数は件数が増えるほど1回のシミュレーションあたりの実時間
 * (setTimeoutの積み上げ)も伸びるため、大きいtierほど減らす——
 * p50/p95の値そのものは、この方式では「呼び出し回数×固定遅延仮定値」
 * にほぼ比例して決まる(ジッターの影響は数十ms程度)ため、試行回数を
 * 減らしても結論(SLOを満たすか否か)は変わらない。
 */
function trialsFor(size: number): number {
  if (size <= 1000) return 15;
  if (size <= 5000) return 8;
  if (size <= 10000) return 5;
  return 3;
}

async function runTier(size: number) {
  const TRIALS = trialsFor(size);
  console.log(`\n=== 件数 ${size.toLocaleString("ja-JP")}(試行回数=${TRIALS}) ===`);
  const table = makeTable(size);

  const listTimes: number[] = [];
  const nextPageTimes: number[] = [];
  const backTimes: number[] = [];
  const searchTimes: number[] = [];
  const advancedTimes: number[] = [];
  const detailTimes: number[] = [];
  let listCalls = 0;

  for (let i = 0; i < TRIALS; i++) {
    const initial = await simListInventory(table, 0, 50);
    listTimes.push(initial.elapsedMs);
    listCalls = initial.calls;

    const next = await simListInventory(table, 50, 50);
    nextPageTimes.push(next.elapsedMs);

    const back = await simListInventory(table, 0, 50);
    backTimes.push(back.elapsedMs);

    const search = await simQuickSearch(table, "商品1");
    searchTimes.push(search.elapsedMs);

    const advanced = await simAdvancedSearch(table, "cat-A", "loc-3");
    advancedTimes.push(advanced.elapsedMs);

    const detail = await simGetInventoryDetail(12); // 典型的な編集履歴行数の仮定(実測ではない、平均的な運用を想定した目安)
    detailTimes.push(detail.elapsedMs);
  }

  console.log(`  1回のlist系呼び出し(全件取得)あたりのAppSyncコール回数: ${listCalls}(200件/pageのnextTokenループ、この件数では全て同じ)`);

  const results = checkSlo([
    { op: "一覧初期表示", p50: percentile(listTimes, 50), p95: percentile(listTimes, 95), sloP50: 1000, sloP95: 1800 },
    { op: "次ページ", p50: percentile(nextPageTimes, 50), p95: percentile(nextPageTimes, 95), sloP50: 500, sloP95: 1000 },
    { op: "戻る(前ページ)", p50: percentile(backTimes, 50), p95: percentile(backTimes, 95), sloP50: 300, sloP95: 600 },
    { op: "クイック検索", p50: percentile(searchTimes, 50), p95: percentile(searchTimes, 95), sloP50: 500, sloP95: 1000 },
    { op: "詳細検索(AND/OR)", p50: percentile(advancedTimes, 50), p95: percentile(advancedTimes, 95), sloP50: 500, sloP95: 1000 },
    { op: "商品詳細ページ", p50: percentile(detailTimes, 50), p95: percentile(detailTimes, 95), sloP50: 500, sloP95: 1000 },
  ]);
  results.forEach((l) => console.log(l));

  return { size, listCalls };
}

async function main() {
  console.log("BELLO統合業務OS 第五ラウンド§7/§43(P0-C) Inventory性能baseline");
  console.log(`仮定値: AppSync 1呼び出し=${SIM.appsyncCallMs}±${SIM.appsyncJitterMs}ms(未実測、根拠は上記コメント参照)、試行回数は件数tierごとに可変(trialsFor参照)`);

  // 現状運用規模(~1000件超)と、安全弁SEARCH_MAX_SCAN_ITEMS=20000に
  // 近い規模の両方を測定する。
  for (const size of [100, 1000, 5000, 10000, 20000]) {
    await runTier(size);
  }

  console.log("\n=== 設計上の事実(件数に依らず常に成立、SIM値に依存しない) ===");
  console.log("  - 「次ページ」「戻る」は、offsetが違うだけで内部的には毎回fetchAllInventoryRecordsを再実行しており、初回一覧と全く同じ「全件取得+ソート」コストを毎回払う。DynamoDBレベルのoffsetページングにはなっていない(offsetはメモリ上のslice位置に過ぎない)。");
  console.log("  - 「戻る」のSLO(p50<300ms)は一覧本体(p50<1.0s)より厳しいが、実装上「戻る」だけを軽くする仕組みは無い——上のtier別結果で件数が増えるとp50<300msを満たせなくなるタイミングが、まさにこの設計上の限界を示す。");
  console.log("  - 商品詳細ページは第五ラウンドP0-BのInventoryHistory GSI化により、件数(全InventoryHistory行数)に依らず定数時間に近い——一覧/検索とは性質が異なる。");
  console.log("  - サムネイル配信: 一覧の各行が独立してクライアント側でgetUrl()を呼ぶ設計(N行=N並列呼び出し)だったのを、第五ラウンドP0-Cでモジュールスコープの10分TTLキャッシュに変更済み(app/inventory/useInventoryImageUrl.ts)——同一storageKeyへの再訪問(戻る等)は再署名を避ける。ただし初回描画時のN並列呼び出し自体は変更していない(仮想化されていないテーブルの全行が同時にmountするため)。");
}

main().catch((err) => {
  console.error("benchmark-inventory-queries.ts FAILED:", err);
  process.exit(1);
});

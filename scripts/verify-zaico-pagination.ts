/**
 * ZAICO全件取得のページ反復テスト（2026-08-31 最終仕上げ指示書 §3.7）。
 *
 * 仕様は「実ZAICOアカウントに現時点で1,000件しか存在しない場合でも、
 * 1,001件以上を扱えることを自動テストで証明する」ことを求めている。
 * ここでは実装と同じページング契約（page / perPage / hasMore）を持つ
 * 疑似APIを用意し、実際の反復処理 `paginateAll` をそのまま通す。
 *
 * Run with: npm run verify:zaico-pagination
 */
import { paginateAll, describeStopReason, type FetchPage, type ZaicoPage } from "@/lib/zaico/pagination";

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

interface Item {
  id: number;
}

/**
 * 件数を指定した疑似ZAICO API。実装と同じ「要求より少なければ最終ページ」
 * という規約で hasMore を返す。
 */
function fakeApi(total: number, opts: { failOnPages?: Map<number, number>; emptyAfter?: number } = {}): {
  fetch: FetchPage<Item>;
  calls: number[];
} {
  const calls: number[] = [];
  const remainingFailures = new Map(opts.failOnPages ?? []);
  const fetch: FetchPage<Item> = async (page, perPage) => {
    calls.push(page);
    const left = remainingFailures.get(page) ?? 0;
    if (left > 0) {
      remainingFailures.set(page, left - 1);
      throw new Error(`一時的なZAICO API障害（page ${page}）`);
    }
    if (opts.emptyAfter !== undefined && page > opts.emptyAfter) {
      return { items: [], hasMore: false };
    }
    const start = (page - 1) * perPage;
    const items: Item[] = [];
    for (let i = start; i < Math.min(total, start + perPage); i++) items.push({ id: i + 1 });
    return { items, hasMore: items.length === perPage };
  };
  return { fetch, calls };
}

/** 取得したidを全部集めて、欠落・重複を数える。 */
async function runFullSync(total: number, perPage = 50) {
  const { fetch, calls } = fakeApi(total);
  const seen: number[] = [];
  const summary = await paginateAll(fetch, {
    perPage,
    onPage: (items) => {
      for (const it of items) seen.push(it.id);
    },
  });
  const unique = new Set(seen);
  const missing: number[] = [];
  for (let i = 1; i <= total; i++) if (!unique.has(i)) missing.push(i);
  return { summary, seen, unique, missing, calls };
}

async function testItemCounts() {
  // 仕様が名指しした件数。1,000の前後と、その先を必ず含める。
  for (const total of [0, 1, 49, 50, 51, 999, 1000, 1001, 2000, 5000]) {
    const { summary, seen, unique, missing } = await runFullSync(total);
    assertEqual(seen.length, total, `${total}件: 取得件数が一致する`);
    assertEqual(unique.size, total, `${total}件: 重複なく取得できる`);
    assertEqual(missing.length, 0, `${total}件: 欠落なく取得できる`);
    assertTrue(summary.completed, `${total}件: 正常終了として扱われる`);
  }
}

async function testPageBoundaries() {
  // 端数の最終ページ（1,001件 = 20ページ満杯 + 1件）
  const odd = await runFullSync(1001);
  assertEqual(odd.summary.pages, 21, "1,001件: 21ページ目で端数1件を取得する");
  assertEqual(odd.summary.stopReason, "LAST_PAGE", "1,001件: 端数ページで最終ページと判定する");

  // 丁度割り切れる場合は、満杯ページの次に空ページが来て終わる
  const exact = await runFullSync(1000);
  assertEqual(exact.summary.stopReason, "EMPTY_PAGE", "1,000件: 割り切れるので次の空ページで終わる");
  assertEqual(exact.summary.pages, 20, "1,000件: 実際に処理したのは20ページ（空ページは数えない）");

  // 0件でも例外にならない
  const empty = await runFullSync(0);
  assertEqual(empty.summary.pages, 0, "0件: 1ページも処理しない");
  assertTrue(empty.summary.completed, "0件: 正常終了として扱う");

  // perPageを変えても件数は変わらない（perPageは取得単位であって上限ではない）
  const p200 = await runFullSync(5000, 200);
  assertEqual(p200.seen.length, 5000, "perPage=200でも5,000件すべて取得する");
  assertEqual(p200.summary.pages, 25, "perPage=200なら25ページで済む");
}

async function testNoFixedItemCap() {
  // 「固定上限を大きな数へ変えただけ」ではないことの確認。
  // ページ上限は件数ではなくページ数の安全装置なので、perPageを上げれば
  // 同じページ上限でより多くの件数を扱える。
  const { fetch } = fakeApi(12000);
  let count = 0;
  const summary = await paginateAll(fetch, {
    perPage: 500,
    maxPages: 30,
    onPage: (items) => { count += items.length; },
  });
  assertEqual(count, 12000, "ページ上限30でも perPage=500 なら12,000件を取得できる（件数上限ではない）");
  assertTrue(summary.completed, "12,000件: 正常終了");
}

/**
 * 実際に起きていた不具合の再現と回帰防止。
 *
 * ZAICOの `/inventories` は per_page を無視し、**常に1,000件**返す
 * (2026-08-31実測。per_page=10/50/100/500/1000/2000/未指定、および
 *  limit/count/size/per/page_size/perPage のいずれでも1,000件)。
 * 旧実装は `hasMore = items.length === perPage` としていたため、
 * `1000 === 50` が偽になり **1ページ目だけを処理して完了扱い**になっていた。
 * 実在庫5,312件に対し、4,312件が一度も同期されていなかった。
 */
function fixedPageSizeApi(total: number, serverPageSize: number): FetchPage<Item> {
  return async (page, _requestedPerPage) => {
    const start = (page - 1) * serverPageSize;
    const items: Item[] = [];
    for (let i = start; i < Math.min(total, start + serverPageSize); i++) items.push({ id: i + 1 });
    // 実装と同じ判定（修正後）: 件が返る限り次があるとみなす
    return { items, hasMore: items.length > 0 };
  };
}

async function testServerIgnoresPerPage() {
  // 実測どおりの条件: 5,312件、サーバは常に1,000件返す、こちらは50を要求
  const seen = new Set<number>();
  const summary = await paginateAll(fixedPageSizeApi(5312, 1000), {
    perPage: 50,
    onPage: (items) => { for (const it of items) seen.add(it.id); },
  });
  assertEqual(seen.size, 5312, "per_page無視: 要求50・応答1,000でも5,312件すべて取得する");
  assertTrue(summary.completed, "per_page無視: 正常終了として扱う");
  assertEqual(summary.pages, 6, "per_page無視: 1,000件×5 + 312件で6ページ");

  // 旧実装の判定を再現すると1,000件で止まることを示す（回帰の可視化）
  const brokenApi: FetchPage<Item> = async (page, requestedPerPage) => {
    const start = (page - 1) * 1000;
    const items: Item[] = [];
    for (let i = start; i < Math.min(5312, start + 1000); i++) items.push({ id: i + 1 });
    return { items, hasMore: items.length === requestedPerPage }; // ← 旧実装
  };
  let brokenCount = 0;
  await paginateAll(brokenApi, { perPage: 50, onPage: (items) => { brokenCount += items.length; } });
  assertEqual(brokenCount, 1000, "旧判定の再現: items.length === perPage で比較すると1,000件で止まる");
}

async function testRunawayGuard() {
  // 常に満杯ページを返し続ける壊れたAPI。止まらないと無限ループになる。
  const runaway: FetchPage<Item> = async (page, perPage) => {
    const items: Item[] = [];
    for (let i = 0; i < perPage; i++) items.push({ id: page * 1000 + i });
    return { items, hasMore: true };
  };
  let pages = 0;
  const summary = await paginateAll(runaway, { perPage: 50, maxPages: 10, onPage: () => { pages++; } });
  assertEqual(pages, 10, "暴走防止: ページ上限で停止する");
  assertEqual(summary.stopReason, "PAGE_LIMIT", "暴走防止: 停止理由がPAGE_LIMIT");
  assertTrue(!summary.completed, "暴走防止: 正常終了として扱わない（黙って打ち切らない）");
  assertTrue(describeStopReason(summary).includes("件数の上限ではなく"), "暴走防止: 利用者向け説明で件数上限ではないと明示する");
}

async function testDuplicatePageDetection() {
  // ページ番号を進めても同じ内容が返るAPI（cursor/pageの実装差異で起こりうる）
  const stuck: FetchPage<Item> = async (_page, perPage) => {
    const items: Item[] = [];
    for (let i = 0; i < perPage; i++) items.push({ id: i + 1 });
    return { items, hasMore: true };
  };
  let processed = 0;
  const summary = await paginateAll(stuck, { perPage: 50, maxPages: 1000, onPage: (items) => { processed += items.length; } });
  assertEqual(summary.stopReason, "DUPLICATE_PAGE", "重複ページ: 同じページの繰り返しを検知して止める");
  assertTrue(!summary.completed, "重複ページ: 正常終了として扱わない");
  assertEqual(processed, 50, "重複ページ: 同じデータを何度も処理しない（1ページ分で止まる）");
}

async function testAbort() {
  const { fetch } = fakeApi(5000);
  let pages = 0;
  const summary = await paginateAll(fetch, {
    perPage: 50,
    onPage: () => { pages++; },
    shouldAbort: () => pages >= 3,
  });
  assertEqual(summary.stopReason, "ABORTED", "中断: 呼び出し側の要求で止まる");
  assertEqual(summary.pages, 3, "中断: 中断時点までのページ数を返す");
  assertTrue(summary.completed, "中断: 異常ではないので正常終了として扱う");
}

async function testTransientFailurePropagates() {
  // 一時障害はこの層では握りつぶさない。retryはHTTPクライアント側
  // (lib/zaico/client.ts の MAX_ATTEMPTS)の責務で、ここで二重に
  // リトライすると同じページを二度処理しかねない。
  const { fetch } = fakeApi(500, { failOnPages: new Map([[3, 99]]) });
  let processed = 0;
  let threw = false;
  try {
    await paginateAll(fetch, { perPage: 50, onPage: (items) => { processed += items.length; } });
  } catch {
    threw = true;
  }
  assertTrue(threw, "一時障害: リトライ上限に達した障害はそのまま呼び出し側へ伝える");
  assertEqual(processed, 100, "一時障害: 失敗ページより前の2ページ分だけが処理済み（重複処理しない）");
}

async function testRetrySucceedsAtClientLayer() {
  // クライアント層のretryが成功するケースの再現: 2回失敗して3回目に成功する
  // ページを、retryでくるんだfetchで通す。反復処理側は何も特別扱いしない。
  const { fetch } = fakeApi(300, { failOnPages: new Map([[2, 2]]) });
  const withRetry: FetchPage<Item> = async (page, perPage) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await fetch(page, perPage);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
  const seen = new Set<number>();
  const summary = await paginateAll(withRetry, {
    perPage: 50,
    onPage: (items) => { for (const it of items) seen.add(it.id); },
  });
  assertEqual(seen.size, 300, "retry成功: 一時障害を挟んでも300件すべて取得する");
  assertTrue(summary.completed, "retry成功: 正常終了");
}

async function testResumeAfterInterruption() {
  // 中断→再実行。worker/background syncはチェックポイントを持ち、
  // 途中から再開する。ここでは「途中まで処理済みのidを持った状態で
  // もう一度全件流しても、重複も欠落も生まれない」ことを確認する。
  const total = 1001;
  const firstRun = await runFullSync(total);
  const processedFirst = new Set(firstRun.seen.slice(0, 320));

  const { fetch } = fakeApi(total);
  const secondRun = new Set<number>();
  await paginateAll(fetch, {
    perPage: 50,
    onPage: (items) => { for (const it of items) secondRun.add(it.id); },
  });

  const union = new Set([...processedFirst, ...secondRun]);
  assertEqual(union.size, total, "中断再実行: 再実行後も全件が揃う");
  assertEqual(secondRun.size, total, "中断再実行: 2回目も全件取得できる（べき等）");
}

async function testFullResyncIsStable() {
  // 同じデータへ何度full resyncしても、取得内容は毎回同一。
  const a = await runFullSync(2000);
  const b = await runFullSync(2000);
  assertEqual(a.seen.length, b.seen.length, "full resync: 2回流しても取得件数が同じ");
  assertEqual(a.summary.pages, b.summary.pages, "full resync: ページ数も同じ（決定論的）");
  assertEqual(JSON.stringify(a.seen) === JSON.stringify(b.seen), true, "full resync: 取得順も同一");
}

async function testSingleChange() {
  // 変更1件 / 新規1件の扱いは同期側(syncOneZaicoItem)の責務だが、
  // ページ反復としては「件数が1件増えたら最終ページが1件増える」だけ。
  const before = await runFullSync(1000);
  const after = await runFullSync(1001);
  assertEqual(after.seen.length - before.seen.length, 1, "新規1件: 総取得件数がちょうど1件増える");
  assertTrue(after.unique.has(1001), "新規1件: 増えた1件が取得できている");
  assertEqual(after.summary.pages - before.summary.pages, 1, "新規1件: 端数ページが1つ増えるだけ");
}

async function main(): Promise<void> {
  await testItemCounts();
  await testPageBoundaries();
  await testNoFixedItemCap();
  await testServerIgnoresPerPage();
  await testRunawayGuard();
  await testDuplicatePageDetection();
  await testAbort();
  await testTransientFailurePropagates();
  await testRetrySucceedsAtClientLayer();
  await testResumeAfterInterruption();
  await testFullResyncIsStable();
  await testSingleChange();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

void main();

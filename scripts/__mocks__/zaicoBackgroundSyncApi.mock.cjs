/**
 * scripts/verify-zaico-retry-persistence.ts 専用fixture(task_9c59e22b1e26721377)。
 *
 * lib/inventory/zaicoBackgroundSync.ts が直接呼ぶ lib/zaico/client.ts の
 * `listInventories`だけを差し替える(ZAICO APIへの実際の通信を避ける)。
 * scripts/verify-zaico-worker-boundary.ts のmockListInventoriesと同じ
 * 発想——ページ定義の配列を順番に返すだけの単純なfake。
 */

let pages = [];
const calls = [];

function __setPages(newPages) {
  pages = newPages;
  calls.length = 0;
}

async function listInventories(page, perPage) {
  calls.push({ page, perPage });
  const def = pages[page - 1];
  if (!def) return { items: [], hasMore: false };
  return def;
}

module.exports = { __setPages, calls, listInventories };

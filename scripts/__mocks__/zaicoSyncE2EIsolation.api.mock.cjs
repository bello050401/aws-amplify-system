/**
 * scripts/verify-zaico-sync-e2e-isolation.ts 専用。lib/zaico/client.tsの
 * `listInventories`(実ZAICO APIへのHTTPS呼び出し)だけを差し替え、
 * 呼ばれた回数を`__calls`へ記録する。
 */
const calls = [];

function __resetCalls() {
  calls.length = 0;
}

async function listInventories(page, perPage) {
  calls.push({ page, perPage });
  return { items: [], hasMore: false };
}

module.exports = { __resetCalls, __calls: calls, listInventories };

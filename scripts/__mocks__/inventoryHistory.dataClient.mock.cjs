/**
 * scripts/verify-inventory-history-boundary.ts 専用fixture。
 *
 * lib/inventory/queries.ts の getInventoryHistory が呼ぶ
 * lib/amplify/dataClient.ts の `serverDataClient`/`inventoryAuthMode`
 * だけを差し替える(scripts/__mocks__/salesAggregateStore.dataClient.mock.cjs
 * と同じ設計・同じ理由——本物のserverDataClientはCookie認証+
 * amplify_outputs.jsonをモジュール読込時にimportするため、この
 * worktree([[qa-worktree-tooling-limits]]参照)ではそのまま使えない)。
 * InventoryHistory.listInventoryHistoryByInventoryIdAndChangedAt()の
 * 戻り値({data, errors})だけを差し替えられるin-memoryスタブ、または
 * 明示的にreject(通信断・タイムアウト等の非GraphQLエラー)させられる
 * スタブにする——実際のGraphQL呼び出しは一切行わない。
 *
 * .mjs ではなく .cjs にしている理由も同じ(salesAggregateStore版の
 * コメント参照): tsxがCJS出力するqueries.tsから.mjsをrequireすると
 * Module._cacheが分裂し、__setListResult()が実際に参照される
 * インスタンスへ反映されない。
 */

let listResult = { data: [], errors: undefined };
let listRejection = null;
const calls = { list: [] };

/** 次のlistInventoryHistoryByInventoryIdAndChangedAt()の戻り値({data, errors})を設定する。 */
function __setListResult(result) {
  listResult = result;
  listRejection = null;
  calls.list = [];
}

/** 次の呼び出しをreject(例外)させる——GraphQL errorsではなく、ネットワーク断・認証失効等の非GraphQLエラーを模す。 */
function __setListRejection(err) {
  listRejection = err;
  calls.list = [];
}

const inventoryAuthMode = { authMode: "userPool" };

const serverDataClient = {
  models: {
    InventoryHistory: {
      async listInventoryHistoryByInventoryIdAndChangedAt(key, opts) {
        calls.list.push({ key, opts });
        if (listRejection) throw listRejection;
        return listResult;
      },
    },
  },
};

module.exports = { calls, __setListResult, __setListRejection, inventoryAuthMode, serverDataClient };

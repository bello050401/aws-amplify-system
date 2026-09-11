/**
 * scripts/verify-sales-aggregate-store-boundary.ts 専用fixture。
 *
 * lib/inventory/salesAggregateStore.ts が呼ぶ lib/amplify/dataClient.ts の
 * `serverDataClient`/`inventoryAuthMode` だけを差し替える——本物の
 * serverDataClientはCookie認証+@/amplify_outputs.jsonをモジュール読込時に
 * importするため、このworktree([[qa-worktree-tooling-limits]]参照)では
 * そのまま使えない。ここではSalesAggregateSnapshot.get()の戻り値
 * ({data, errors})だけを差し替えられるin-memoryスタブにする——実際の
 * GraphQL呼び出しは一切行わない。
 *
 * .mjs ではなく .cjs にしているのは意図的(2026-09-11 task_e509 引継ぎ
 * 完了対応): このリポジトリに package.json "type":"module" が無いため、
 * lib/inventory/salesAggregateStore.ts(トップレベルawaitを持たない.ts)は
 * tsxによってCJS出力に変換される。CJS化されたモジュールからこの
 * fixtureを.mjs(=常にESM)としてrequireすると、Node の require(esm)
 * 相互運用は "await import()" で直接読み込んだ別インスタンスとは別の
 * モジュールレコードを作ってしまい、テスト側の __setGetResult() が
 * 実際にstoreが参照するインスタンスへ反映されない(状態が分裂する)。
 * .cjs であれば require() 経由でも import() 経由でも同じ
 * Module._cache を共有するため、この分裂が起きない。
 */

let getResult = { data: null, errors: undefined };
const calls = { get: [] };

/** 次のSalesAggregateSnapshot.get()の戻り値({data, errors})を設定する。 */
function __setGetResult(result) {
  getResult = result;
  calls.get = [];
}

const inventoryAuthMode = { authMode: "userPool" };

const serverDataClient = {
  models: {
    SalesAggregateSnapshot: {
      async get(key, opts) {
        calls.get.push({ key, opts });
        return getResult;
      },
    },
  },
};

module.exports = { calls, __setGetResult, inventoryAuthMode, serverDataClient };

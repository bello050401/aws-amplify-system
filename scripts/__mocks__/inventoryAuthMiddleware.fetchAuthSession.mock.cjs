/**
 * scripts/verify-inventory-auth-middleware.ts 専用fixture(middleware.ts
 * の実境界試験、2026-09-13、task_83af1d1b9dab4d9893)。
 *
 * "aws-amplify/auth/server" の `fetchAuthSession` だけを差し替える——
 * 実Cognitoが「有効/リフレッシュ成功/リフレッシュ失敗」のどれを返すかの
 * 判断そのもの(実SDK内部のCognitoプロトコル)はここでは検証しない
 * (このタスクの範囲外——完了報告に明記)。検証したいのは「SDKがその
 * 判断の結果としてCookieアダプタのset()を呼んだとき、middleware.tsの
 * 実NextResponseへ本当にSet-Cookie/x-middleware-set-cookieが乗るか」
 * ——その1点にmockの責務を絞る。
 *
 * behaviorは`contextSpec`(inventoryAuthMiddleware.serverUtils.mock.cjs
 * が渡す、実Cookieアダプタ{get,getAll,set,delete})を受け取り、テストの
 * 各シナリオで`__setBehavior`から差し替える。
 */
'use strict';

let behavior = async () => ({ tokens: undefined });

async function fetchAuthSession(contextSpec) {
  return behavior(contextSpec);
}

module.exports = {
  fetchAuthSession,
  /** @param {(contextSpec: unknown) => Promise<unknown>} fn */
  __setBehavior(fn) {
    behavior = fn;
  },
  __reset() {
    behavior = async () => ({ tokens: undefined });
  },
};

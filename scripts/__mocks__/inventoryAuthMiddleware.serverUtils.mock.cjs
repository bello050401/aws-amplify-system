/**
 * scripts/verify-inventory-auth-middleware.ts 専用fixture(middleware.ts
 * の実境界試験、2026-09-13、task_83af1d1b9dab4d9893)。
 *
 * middleware.tsの1つ下の依存(@/lib/amplify/serverUtils の
 * runWithAmplifyServerContext)だけを差し替える——他のverify-*.tsと同じ
 * 設計(対象モジュール自体は実物のままimportし、その1つ下だけを
 * mockへ差し替える)。
 *
 * ただし、ここは「まるごと偽物」ではない: @aws-amplify/adapter-nextjsの
 * 実物である`createCookieStorageAdapterFromNextServerContext`
 * (dist/cjs/utils/createCookieStorageAdapterFromNextServerContext.js)を
 * そのままrequireして使う。これはmiddleware.tsが実際に依存している
 * Cookie書き込みの実コード——`nextServerContext: {request, response}`を
 * 受け取り、`response.cookies.set()`(next/serverの実NextResponse、実
 * NextRequestに対する本物の書き込み)へ実際に書く。
 *
 * 差し替えているのは「その先」——実Cognito・実`@aws-amplify/adapter-core`の
 * credentialsProvider/tokenProvider構築(実AWS設定・実ネットワークを要る)
 * だけを迂回し、`operation(contextSpec)`にその実Cookieアダプタを直接渡す。
 * これにより、fetchAuthSessionのmock(inventoryAuthMiddleware.
 * fetchAuthSession.mock.cjs)が`contextSpec.set(...)`を呼べば、実際に
 * middleware.tsが返す実NextResponseにSet-Cookie/x-middleware-set-cookie
 * ヘッダーが乗ることを、本物のCookie配線で確認できる。
 *
 * 「@aws-amplify/adapter-nextjsの実コードを動かす」ために、パッケージの
 * package.json "exports" に無い内部パス(dist/cjs/utils/...)を絶対パス
 * 経由でrequireする(絶対パスでのrequireはexportsマップの制約を受けない
 * ——パッケージ名/サブパス指定でのimportだけが制約される)。
 */
'use strict';

const path = require('node:path');

const adapterPackageJsonPath = require.resolve('@aws-amplify/adapter-nextjs/package.json');
const adapterDir = path.dirname(adapterPackageJsonPath);
const { createCookieStorageAdapterFromNextServerContext } = require(
  path.join(adapterDir, 'dist', 'cjs', 'utils', 'createCookieStorageAdapterFromNextServerContext.js'),
);

/**
 * middleware.tsが呼ぶのと同じ形({nextServerContext, operation})。
 * ignoreNonServerSideCookies(第2引数)は実運用のglobalSettings由来の値
 * だが、このtestの関心(Cookie書き込みがNextResponseへ実際に届くか)には
 * 影響しない——既定のfalseで固定する(実配線を単純化するための既知の
 * 簡略化、完了報告に明記)。
 */
async function runWithAmplifyServerContext({ nextServerContext, operation }) {
  const cookieAdapter = await createCookieStorageAdapterFromNextServerContext(nextServerContext, false);
  return operation(cookieAdapter);
}

module.exports = { runWithAmplifyServerContext };

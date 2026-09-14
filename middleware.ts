import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { isE2EFixtureModeActive } from "@/lib/inventory/e2eFixtures";

/**
 * /inventory配下専用のセッション更新境界(task_4e04c971153ee1eb39の候補を
 * 検証・補正、2026-09-13、実報告EC-channelListings-auth-expiredの調査
 * から追加)。
 *
 * ## なぜ必要か — 実SDK(@aws-amplify/adapter-nextjs)ソースで確認した事実
 *
 * `getInventorySessionStatus`(lib/amplify/requireInventoryUser.ts)と
 * `serverDataClient`(lib/amplify/dataClient.ts、
 * `generateServerClientUsingCookies`経由)は、完全に独立した2つの
 * Amplifyサーバーコンテキスト——片方のトークンリフレッシュ結果がもう
 * 片方に共有されることはない。さらに`generateServerClientUsingCookies`
 * 側は、呼び出しの**たびに**新しいcredentialsProvider/tokenProvider/
 * keyValueStorageを作り直す(node_modules/@aws-amplify/adapter-nextjs/
 * dist/cjs/api/generateServerClient.jsの`getAmplify`)——EC一覧の4本の
 * 並列読み取り(lib/listing/service.tsの`fetchListingsOverviewRows`)は
 * アクセストークンが期限切れのとき、それぞれ独立にCognitoへの
 * リフレッシュを試みることになる(スロットリング等で一部だけ失敗する
 * 余地がある)。
 *
 * そのリフレッシュ結果をCookieへ書き戻す処理は、呼ばれた場所が
 * Server Component のレンダー中(page.tsx/layout.tsx、`next/headers`の
 * `cookies()`経由)だと——`cookies()`が読み取り専用を返すため——SDK自身が
 * 例外を握りつぶして何もしない(no-op、node_modules/@aws-amplify/
 * adapter-nextjs/dist/cjs/utils/createCookieStorageAdapterFromNextServerContext.js
 * の`createCookieStorageAdapterFromNextCookies`のコメント「When Next
 * cookies() is called in a server component, it returns a readonly
 * cookie store...We have no way to detect which one is returned, so we
 * try to call set and delete and safely ignore the error」)。つまり一度
 * アクセストークンが期限切れになった後は、ブラウザのCookieが更新され
 * ないまま毎リクエスト同じ期限切れトークンが送られ続け、4本バラバラの
 * (しかも毎回捨てられる)リフレッシュが繰り返される——本人画面
 * (layout.tsxのgetInventorySessionStatus)は成功するのにChannelListingの
 * 読み取りだけがauth-expired相当のエラーになる非対称は、この構造から
 * 起こり得る。
 *
 * ## middlewareが同一リクエストの後続読み取りまで直すことを確認した事実
 *
 * middlewareのnextServerContextは`{request, response}`の形——
 * `createCookieStorageAdapterFromNextServerContext`はこの形を
 * `response instanceof NextResponse`で判定し、書き込みを
 * `response.cookies.set()`(読み取り専用ではない)へ向ける
 * (createCookieStorageAdapterFromNextRequestAndNextResponse、上記
 * ファイル参照)——ここは読み取り専用no-opに当たらない、実際に書ける
 * 経路。
 *
 * さらに、ここで`response.cookies.set()`を呼ぶだけで**今回と同じ
 * リクエストの**Server Component/Route Handler側の`cookies()`
 * (getInventorySessionStatus・serverDataClientが実際に使っているのと
 * 同じ`next/headers`の`cookies()`)まで新しい値が届くことを、Next.js
 * 14.2.35本体のソースで確認した(先行候補のコメントは「保証しない」と
 * 保留していたが、実際には確認できた):
 *   1. `NextResponse`の`cookies`プロキシは`.set()/.delete()`のたびに、
 *      通常のSet-Cookieヘッダーへの反映と**別に**
 *      `x-middleware-set-cookie`ヘッダーへ直列化した値を書く
 *      (node_modules/next/dist/server/web/spec-extension/response.js)。
 *   2. middleware実行後、Next.js本体のリクエスト処理
 *      (node_modules/next/dist/server/lib/router-utils/resolve-routes.js)
 *      が`x-middleware-set-cookie`を**続くレンダー用の`req.headers`**へ
 *      コピーする(ブラウザ向けレスポンスには載せない——ブラウザには
 *      別途通常のSet-Cookieが届く、node_modules/next/dist/server/
 *      send-response.jsで確認)。
 *   3. Server Component/Route Handlerの`cookies()`
 *      (node_modules/next/dist/client/components/headers.jsの`cookies`)
 *      が返す値は、`RequestAsyncStorageWrapper.wrap`が組み立てる
 *      (node_modules/next/dist/server/async-storage/
 *      request-async-storage-wrapper.js)。その`mergeMiddlewareCookies`
 *      が、まさに手順2で`req.headers`へコピーされた
 *      `x-middleware-set-cookie`を読み、同一リクエストの`cookies()`へ
 *      merge する——コメントにも明記されている
 *      ("so that when cookies() is accessed it's able to read the newly
 *      set cookies")。
 *
 * `getInventorySessionStatus`(requireInventoryUser.ts)も
 * `serverDataClient`(dataClient.ts)も、この`next/headers`の`cookies()`を
 * そのまま渡している(`nextServerContext: { cookies }`)ので、上の経路に
 * 乗る——middlewareがここで一度リフレッシュ・永続化しておけば、**今回の
 * レンダーの4本の並列読み取り**も含めて、新しいトークンを最初から読める
 * 見込みが高い(これが実ユーザー報告の非対称——layoutは成功するのに
 * ChannelListingだけ失敗する——を構造的に解消する)。
 *
 * 残る留保: (a) middleware自身のリフレッシュそのものが失敗した場合
 * (下記参照)は当然この恩恵を受けない、(b) この経路はNext.js 14.2.35の
 * 内部実装(`x-middleware-set-cookie`)に依存しており将来のNextのバージョン
 * では変わりうる、(c) このリポジトリがAWS Amplify Hosting上でどの
 * サーバーハンドラー経由でNextを起動しているか(`next start`と完全に
 * 同一の内部処理を通るか)までは実デプロイ環境で未確認——実ユーザーでの
 * 再現確認はCodex側の作業。
 *
 * 強制再ログインの常態化や無限リトライはしない: リフレッシュが失敗
 * (リフレッシュトークン自体が無効/期限切れ、Cognitoエラー等)しても、
 * ここでは何もせず素通しする。既存の`getInventorySessionStatus`のtry/catch
 * (失敗時はsigned-out扱い→保護レイアウトがログイン画面へリダイレクト)が、
 * 真にリフレッシュ不能なセッションの案内を引き続き担う——ここでは重複した
 * リダイレクトを行わない。秘密値(トークン本体)はログに出さない——このtry/
 * catchはcatch節で何も出力しない。
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next();
  // 2026-09-14 P1修正: 非本番二重ゲート(isE2EFixtureModeActive——
  // NODE_ENV!=='production' かつ INVENTORY_E2E_FIXTURES==='1')が
  // 立っている間は、下のfetchAuthSessionを呼ばずそのまま素通しする。
  //
  // 【なぜCookie単位のresolveE2EBypassRoleではなくprocess全体のゲートか】
  // 最初はresolveE2EBypassRole(署名済みCookie一致が必須)で個別
  // リクエストだけ止めようとしたが、それでも到達が残った——
  // PlaywrightのwebServer readiness probe(/inventory/loginへの素の
  // GET)やテストの最初のnavigation(まだpage.context().addCookies()を
  // 呼ぶ前)にはそもそもCookieが乗らないため、そこだけresolveE2E
  // BypassRoleがnullを返し素通り(=下のfetchAuthSessionへ落ちる)して
  // いた(実測、net.Socket.prototype.connect/tls.connect計装で
  // cognito-identity.<region>.amazonaws.comへの接続試行として確認)。
  // playwright.config.tsのwebServer.envはプロセス全体にINVENTORY_E2E_
  // FIXTURES=1を立てる——このプロセス内で実Cognitoセッションが有効に
  // なることはそもそも無いので、Cookieの有無に関わらずリフレッシュ
  // 自体が意味を持たない。本番(NODE_ENV==='production')では
  // isE2EFixtureModeActiveが常にfalseを返すため、この分岐は構造的に
  // 通らず、下の実リフレッシュ経路は無変更。
  if (isE2EFixtureModeActive()) {
    return response;
  }
  try {
    await runWithAmplifyServerContext({
      nextServerContext: { request, response },
      operation: (contextSpec) => fetchAuthSession(contextSpec),
    });
  } catch {
    // 更新不能 — ここでは何もしない(上記コメント参照)。秘密値を含み
    // うる例外の内容はログに出さない。
  }
  return response;
}

export const config = {
  // /inventory以外のシステム(特集ページ/admin等)には一切影響しない。
  matcher: ["/inventory/:path*"],
};

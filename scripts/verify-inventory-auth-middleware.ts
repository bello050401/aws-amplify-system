/**
 * middleware.ts(task_4e04c971153ee1eb39の候補を検証・補正、
 * task_83af1d1b9dab4d9893)の実境界試験。
 *
 * ## このtestが埋める穴
 *
 * 先行候補(commit 620a78b)はmiddleware.tsを新設したが、追加された試験は
 * すべて lib/listing/overviewFailure.ts の分類ロジック
 * (classifyListingsOverviewErrorKind/reconcileAuthExpiredKind)だけを
 * 見るもので、middleware.ts自体は一度も呼ばれていなかった——「Cookieを
 * 書き込む境界が実際に機能するか」は未検証のまま残っていた
 * (レビュー指摘、本タスクの指示書§4)。このファイルは、実際の
 * `middleware`関数を実NextRequest/NextResponseに対して呼び、Set-Cookie/
 * x-middleware-set-cookieが実際に返るかを確認する。
 *
 * ## 実物 / mock の境界(このtestの設計判断)
 *
 * 実物のまま:
 *   - middleware.ts自体(このtestの対象)。
 *   - next/serverのNextRequest/NextResponse(実際の受け渡し形)。
 *   - @aws-amplify/adapter-nextjsのcreateCookieStorageAdapterFromNext
 *     ServerContext(scripts/__mocks__/inventoryAuthMiddleware.
 *     serverUtils.mock.cjs経由——絶対パスでの直接require、内部Cookie
 *     書き込みコードそのもの)。
 *
 * mock(SDK境界——実Cognito/実AWS設定を要る層だけを差し替える):
 *   - "aws-amplify/auth/server"のfetchAuthSession(scripts/__mocks__/
 *     inventoryAuthMiddleware.fetchAuthSession.mock.cjs)。
 *   - "@/lib/amplify/serverUtils"のrunWithAmplifyServerContext
 *     (実credentialsProvider/tokenProvider構築だけを迂回——上記参照)。
 *
 * 検証しないこと(このtestの範囲外、完了報告に明記): 実Cognitoが
 * 「トークンが期限切れか」をどう判断するか、実際のリフレッシュ
 * トークンローテーションの挙動——ここではその判断の**結果**
 * (有効/リフレッシュ成功/リフレッシュ失敗)をfetchAuthSessionのmockで
 * 直接指定する。
 *
 * 実行にはtsxが要る(scripts/verify-listings-overview-service-boundary.ts
 * と同じ理由・同じ実行コマンド、node_modulesはメインチェックアウトからの
 * junction、[[qa-worktree-tooling-limits]]参照):
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-inventory-auth-middleware.ts
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { NextRequest, NextResponse } from "next/server";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const mocksDir = pathToFileURL(process.cwd() + "/scripts/__mocks__/").href;
const FETCH_AUTH_SESSION_MOCK_URL = mocksDir + "inventoryAuthMiddleware.fetchAuthSession.mock.cjs";
const SERVER_UTILS_MOCK_URL = mocksDir + "inventoryAuthMiddleware.serverUtils.mock.cjs";

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === "aws-amplify/auth/server") {
      return { url: FETCH_AUTH_SESSION_MOCK_URL, shortCircuit: true };
    }
    if (specifier === "@/lib/amplify/serverUtils") {
      return { url: SERVER_UTILS_MOCK_URL, shortCircuit: true };
    }
    const isAlias = specifier.startsWith("@/");
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (!isAlias && !isRelative) {
      return nextResolve(specifier, context);
    }
    const target = isAlias ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, context);
    } catch {
      try {
        return nextResolve(target + ".ts", context);
      } catch {
        return nextResolve(target + ".tsx", context);
      }
    }
  },
});

let passes = 0;
let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** console.*が一切呼ばれないこと(秘密値をログに出さない)を実測するためのspy。 */
function spyOnConsole() {
  const calls: string[] = [];
  const methods = ["log", "warn", "error", "info", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = ((...args: unknown[]) => {
      calls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }) as typeof console.log;
  }
  return {
    calls,
    restore() {
      methods.forEach((m, i) => {
        console[m] = originals[i];
      });
    },
  };
}

function makeRequest(cookieHeader: string): NextRequest {
  return new NextRequest("https://bello.example.com/inventory/listings", {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

/** レスポンスの Set-Cookie(ブラウザ向け)から指定Cookie名の値を取り出す。 */
function getSetCookieValue(response: NextResponse, name: string): string | undefined {
  const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
  const line = setCookieHeaders.find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;
  return decodeURIComponent(line.split(";")[0]!.slice(name.length + 1));
}

async function main() {
  const { middleware } = await import("@/middleware");
  const fetchAuthSessionMock = (await import(FETCH_AUTH_SESSION_MOCK_URL)).default;

  const COOKIE_NAME = "amplify.mock.accessToken";
  const SECRET_CANARY = "refresh-token-should-never-appear-in-any-log-abc123";

  console.log("── 有効セッション(リフレッシュ不要) ──────────────────────");
  {
    fetchAuthSessionMock.__setBehavior(async () => ({ tokens: { accessToken: {}, idToken: {} } }));
    const spy = spyOnConsole();

    const response = await middleware(makeRequest(`${COOKIE_NAME}=still-valid-token`));

    spy.restore();
    check(response instanceof NextResponse, "middleware()は実NextResponseを返す");
    check(response.headers.get("x-middleware-next") === "1", "★要件: リクエストをそのまま先へ通す(NextResponse.next()、リダイレクトしない)");
    check(getSetCookieValue(response, COOKIE_NAME) === undefined, "★要件: リフレッシュ不要ならSet-Cookieを追加しない(既存のトークンをいじらない)");
    check(spy.calls.length === 0, "★要件: 有効セッションの経路でconsole.*が一切呼ばれない(secretログなし)");
  }

  console.log("\n── 期限切れだがrefresh可能 → 成功: Set-Cookieが実際に返る ──────");
  {
    fetchAuthSessionMock.__setBehavior(async (contextSpec: { set(name: string, value: string, opts?: unknown): void }) => {
      // 実SDKがリフレッシュに成功したときの挙動を模す: 新しいトークンを
      // 実Cookieアダプタへ書き込む(この書き込みが実際にNextResponseの
      // Set-Cookie/x-middleware-set-cookieへ届くかがこのtestの核心)。
      contextSpec.set(COOKIE_NAME, "freshly-refreshed-token-value", { httpOnly: true, sameSite: "lax" });
      return { tokens: { accessToken: {}, idToken: {} } };
    });
    const spy = spyOnConsole();

    const response = await middleware(makeRequest(`${COOKIE_NAME}=expired-token`));

    spy.restore();
    const newValue = getSetCookieValue(response, COOKIE_NAME);
    check(newValue === "freshly-refreshed-token-value", "★要件(このタスクの本題): リフレッシュ成功時、実NextResponseに新トークンのSet-Cookieが実際に乗る", `got=${newValue}`);
    check(
      !!response.headers.get("x-middleware-set-cookie")?.includes(encodeURIComponent(COOKIE_NAME)),
      "★要件: 同一リクエストの後続レンダー用ヘッダー(x-middleware-set-cookie)にも同じCookieが乗る(Next.js内部機構、request-async-storage-wrapper.jsのmergeMiddlewareCookies参照——ファイル冒頭コメント)",
    );
    check(response.headers.get("x-middleware-next") === "1", "リフレッシュ成功時もリクエストは素通しする(独自リダイレクトを挟まない)");
    check(spy.calls.length === 0, "★要件: リフレッシュ成功の経路でもconsole.*が一切呼ばれない(トークン値をログに出さない)");
  }

  console.log("\n── refresh不能(リフレッシュトークン自体が無効) ──────────────");
  {
    fetchAuthSessionMock.__setBehavior(async () => {
      throw new Error(`NotAuthorizedException: Refresh Token has expired (${SECRET_CANARY})`);
    });
    const spy = spyOnConsole();

    let threw = false;
    let response: NextResponse | undefined;
    try {
      response = await middleware(makeRequest(`${COOKIE_NAME}=expired-token`));
    } catch {
      threw = true;
    }

    spy.restore();
    check(!threw, "★要件: リフレッシュ不能でもmiddleware自体は例外を投げない(素通しする、try/catch参照)");
    check(!!response && response.headers.get("x-middleware-next") === "1", "★要件: リフレッシュ不能でも独自リダイレクトはしない(強制再ログインの常態化禁止——ログイン導線はgetInventorySessionStatus側の既存ロジックに委ねる)");
    check(!!response && getSetCookieValue(response, COOKIE_NAME) === undefined, "リフレッシュ不能ならCookieを書き換えない(古い値をそのまま残す)");
    const leaked = spy.calls.some((c) => c.includes(SECRET_CANARY));
    check(!leaked, "★要件: リフレッシュ失敗の例外内容(秘密を含みうる)が一切ログに出ない", JSON.stringify(spy.calls));
    check(spy.calls.length === 0, "リフレッシュ失敗の経路でconsole.*が一切呼ばれない");
  }

  console.log("\n── 異なるユーザーの分離(同一プロセス内で連続処理) ──────────────");
  {
    // sessionIdごとに異なる新トークンをSDKが返す状況を模す——2ユーザーの
    // リクエストを同一プロセス内で連続処理しても、片方のリフレッシュ結果が
    // もう片方のNextResponseへ混ざらないことを確認する。
    fetchAuthSessionMock.__setBehavior(async (contextSpec: { get(name: string): { value: string } | undefined; set(name: string, value: string, opts?: unknown): void }) => {
      const sessionId = contextSpec.get("sessionId")?.value;
      contextSpec.set(COOKIE_NAME, `refreshed-for-${sessionId}`, {});
      return { tokens: { accessToken: {}, idToken: {} } };
    });

    const responseUserA1 = await middleware(makeRequest(`sessionId=userA; ${COOKIE_NAME}=old-a`));
    const responseUserB = await middleware(makeRequest(`sessionId=userB; ${COOKIE_NAME}=old-b`));
    const responseUserA2 = await middleware(makeRequest(`sessionId=userA; ${COOKIE_NAME}=old-a`));

    check(getSetCookieValue(responseUserA1, COOKIE_NAME) === "refreshed-for-userA", "userAのリフレッシュ結果はuserA自身のレスポンスに乗る");
    check(getSetCookieValue(responseUserB, COOKIE_NAME) === "refreshed-for-userB", "★要件: userBのリフレッシュ結果はuserA向けの値と混ざらない(別ユーザーの分離)");
    check(getSetCookieValue(responseUserA2, COOKIE_NAME) === "refreshed-for-userA", "★要件: userBの処理を挟んだ後の再訪でも、userAは自分自身の値だけを受け取る(状態の取り違えなし)");
  }

  console.log("\n── 再訪: 新しいCookieが最初から来ていればもう一度リフレッシュしない ──");
  {
    let refreshCalls = 0;
    fetchAuthSessionMock.__setBehavior(async (contextSpec: { get(name: string): { value: string } | undefined; set(name: string, value: string, opts?: unknown): void }) => {
      const current = contextSpec.get(COOKIE_NAME)?.value;
      if (current === "already-fresh-token") {
        // 実SDKなら「まだ期限内」と判断してリフレッシュしない経路。
        return { tokens: { accessToken: {}, idToken: {} } };
      }
      refreshCalls++;
      contextSpec.set(COOKIE_NAME, "already-fresh-token", {});
      return { tokens: { accessToken: {}, idToken: {} } };
    });

    await middleware(makeRequest(`${COOKIE_NAME}=expired-token`));
    check(refreshCalls === 1, "1回目(期限切れ)はリフレッシュする");
    const secondResponse = await middleware(makeRequest(`${COOKIE_NAME}=already-fresh-token`));
    check(refreshCalls === 1, "★要件: 再訪時、既に新しいCookieが来ていれば追加のリフレッシュを試みない(無限retryにならない)");
    check(getSetCookieValue(secondResponse, COOKIE_NAME) === undefined, "再訪時はSet-Cookieを重ねて追加しない");
  }

  fetchAuthSessionMock.__reset();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

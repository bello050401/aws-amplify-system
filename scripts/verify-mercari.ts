/**
 * 夜間統合指示書(2026-09-01) §3.3/§3.4/§7: Mercari Shops接続まわりの
 * 純ロジック検証。**Mercariへは一切接続しない**(globalThis.fetchを
 * 差し替えて応答を再現する) —— 実接続の確認は npm run verify:mercari-live。
 *
 * Run with: npm run verify:mercari
 *
 * ここで固定したい振る舞い:
 *
 *  1. どのHTTPステータス・どの壊れた応答でも、外へ出るのは必ず分類済みの
 *     MercariApiErrorであって、生のSyntaxError/TypeErrorではない
 *     (§3.3「raw JavaScript exceptionをUIへ出さない」)。
 *  2. TOKEN本体がエラーメッセージ・ログ・戻り値のどこにも現れない。
 *  3. 保存可否の判断(connectionPolicy)が、IP未登録による保存デッドロックを
 *     解消しつつ、既存の検証済み設定を壊さない。
 *  4. 設定不備や400のような「送り直しても直らない」失敗でリトライしない。
 */
import { MercariShopsClient, extractGraphQLOperationName, positiveIntFromEnv, nonNegativeIntFromEnv } from "@/lib/listing/mercari/client";
import {
  MercariApiError,
  MERCARI_ERROR_LABEL,
  classifyHttpStatus,
  classifyForbiddenError,
  classifyGraphQLErrors,
  isRetryableMercariErrorCode,
  type MercariErrorCode,
} from "@/lib/listing/mercari/errors";
import { decideMercariSave, isMercariRetryableForUser, isMercariTokenRejected } from "@/lib/listing/mercari/connectionPolicy";
import { validateMercariConnection } from "@/lib/listing/mercari/adapter";

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

/** このテスト全体で使う、実在しないダミーTOKEN。漏洩検査の対象文字列でもある。 */
const FAKE_TOKEN = "dummy-token-for-tests-do-not-use-9f2a";
const FAKE_CLIENT = "bello-test-client";

type FetchStub = (input: unknown, init?: unknown) => Promise<Response>;

/** globalThis.fetchを差し替えて呼び出し回数を数える。必ずrestoreすること。 */
function withFetch<T>(stub: FetchStub, fn: (calls: { count: number; lastInit: unknown }) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls = { count: 0, lastInit: undefined as unknown };
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    calls.count++;
    calls.lastInit = init;
    return stub(input, init);
  }) as typeof globalThis.fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
}

/** リトライの指数バックオフでテストが遅くならないよう、既定でリトライを切ったクライアント。 */
function makeClient(): MercariShopsClient {
  return new MercariShopsClient({
    environment: "sandbox",
    getAccessToken: async () => FAKE_TOKEN,
    getUserAgent: async () => `${FAKE_CLIENT}/0.0.0`,
  });
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

// ── §7「Mercari」: HTTPステータスごとの分類 ─────────────────────────

async function testHttpStatusHandling() {
  const cases: Array<{ status: number; body: string; expected: MercariErrorCode; label: string }> = [
    { status: 400, body: "bad request", expected: "BAD_REQUEST", label: "400 -> BAD_REQUEST(公式FAQ: JSON/クエリ構文エラー・Authorizationヘッダ誤り・環境とトークンの不一致)" },
    { status: 401, body: "unauthorized", expected: "AUTH_FAILED", label: "401 -> AUTH_FAILED" },
    { status: 403, body: "Forbidden", expected: "AUTH_FAILED", label: "403(IP文言なし) -> AUTH_FAILED" },
    { status: 404, body: "Not Found\n", expected: "IP_NOT_ALLOWED", label: "404 -> IP_NOT_ALLOWED(公式FAQ「申請していないIPには404を返す」)" },
    { status: 429, body: "too many requests", expected: "RATE_LIMITED", label: "429 -> RATE_LIMITED" },
    { status: 500, body: "oops", expected: "UNKNOWN_REMOTE_ERROR", label: "500 -> UNKNOWN_REMOTE_ERROR" },
    { status: 418, body: "teapot", expected: "UNKNOWN_REMOTE_ERROR", label: "想定外のステータスでも分類済みのエラーになる" },
  ];

  for (const c of cases) {
    await withFetch(
      async () => textResponse(c.body, c.status),
      async () => {
        const err = await captureError(() => makeClient().request("query ProductCategories { productCategories { id } }", {}, { disableRetry: true }));
        assertTrue(err instanceof MercariApiError, `client: HTTP ${c.status}はMercariApiErrorとして投げられる(生の例外が漏れない)`);
        assertEqual((err as MercariApiError).code, c.expected, `client: ${c.label}`);
      },
    );
  }

  // 403でも本文にIP制限を示す語があればIP_NOT_ALLOWEDへ格上げする。
  await withFetch(
    async () => textResponse("Access denied: IP address not allowed", 403),
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertEqual((err as MercariApiError).code, "IP_NOT_ALLOWED", "client: 403でも本文がIP制限を示すならIP_NOT_ALLOWEDへ格上げする");
    },
  );
}

// ── §3.3「non-JSON response処理」 ───────────────────────────────────

async function testNonJsonAndMalformedResponses() {
  // HTTP 200なのに本文がHTML(WAF/プロキシの割り込み)。以前はここで
  // response.json()のSyntaxErrorが生のまま外へ出て、設定画面に
  // 「Unexpected token < in JSON at position 0」が表示され得た。
  await withFetch(
    async () => new Response("<!doctype html><html><body>blocked</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertTrue(err instanceof MercariApiError, "client: HTTP 200でも本文がJSONでなければMercariApiErrorになる(生のSyntaxErrorを外へ出さない)");
      assertEqual((err as MercariApiError).code, "INVALID_RESPONSE", "client: 非JSON応答 -> INVALID_RESPONSE");
      assertTrue(
        !/Unexpected token|JSON\.parse|SyntaxError/i.test((err as MercariApiError).message),
        "client: 利用者向けメッセージにJSONパーサの生の文言を混ぜない",
      );
    },
  );

  // 200 + 本文が空。
  await withFetch(
    async () => new Response("", { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertEqual((err as MercariApiError).code, "INVALID_RESPONSE", "client: 空の本文 -> INVALID_RESPONSE");
    },
  );

  // 200 + JSONだがオブジェクトでない(配列/スカラー)。
  await withFetch(
    async () => jsonResponse("just a string"),
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertEqual((err as MercariApiError).code, "INVALID_RESPONSE", "client: JSONだがオブジェクトでない応答 -> INVALID_RESPONSE");
    },
  );

  // 200 + data無し・errors無し。
  await withFetch(
    async () => jsonResponse({}),
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertEqual((err as MercariApiError).code, "UNKNOWN_REMOTE_ERROR", "client: dataもerrorsも無い応答 -> UNKNOWN_REMOTE_ERROR");
    },
  );

  // 200 + GraphQLエラー。
  await withFetch(
    async () => jsonResponse({ errors: [{ message: "Unauthenticated request" }] }),
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertEqual((err as MercariApiError).code, "AUTH_FAILED", "client: GraphQLエラー本文から分類する");
    },
  );

  // 正常系。
  await withFetch(
    async () => jsonResponse({ data: { productCategories: [{ id: "c1" }] } }),
    async () => {
      const data = await makeClient().request<{ productCategories: Array<{ id: string }> }>("query Q { a }", {}, { disableRetry: true });
      assertEqual(data.productCategories[0].id, "c1", "client: 正常な応答はdataをそのまま返す");
    },
  );
}

// ── §3.3「network timeout」「network error」 ────────────────────────

async function testNetworkAndTimeout() {
  await withFetch(
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertTrue(err instanceof MercariApiError, "client: ネットワーク例外もMercariApiErrorへ畳む");
      assertEqual((err as MercariApiError).code, "NETWORK_ERROR", "client: 到達不能 -> NETWORK_ERROR");
    },
  );

  // AbortErrorはタイムアウト —— 「繋がらない」とは対処が違うので区別する。
  await withFetch(
    async () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      throw e;
    },
    async () => {
      const err = await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }));
      assertEqual((err as MercariApiError).code, "TIMEOUT", "client: 打ち切り(AbortError) -> TIMEOUT(NETWORK_ERRORと混同しない)");
      assertTrue(!/aborted/i.test((err as MercariApiError).message), "client: TIMEOUTの利用者向け文言に生の\"aborted\"を出さない");
    },
  );
}

// ── リトライ: 直らない失敗で無駄に再送しない ────────────────────────

async function testRetryBehaviour() {
  const prev = process.env.MERCARI_MAX_RETRIES;
  process.env.MERCARI_MAX_RETRIES = "1"; // 1回だけ再試行(バックオフ500ms)

  // 400は送り直しても直らない —— 1回で諦める。
  await withFetch(
    async () => textResponse("bad request", 400),
    async (calls) => {
      await captureError(() => makeClient().request("query Q { a }", {}));
      assertEqual(calls.count, 1, "client: 400(BAD_REQUEST)はリトライしない(設定ミスは再送しても直らない)");
    },
  );

  // 404(IP未登録)も同様。
  await withFetch(
    async () => textResponse("Not Found\n", 404),
    async (calls) => {
      await captureError(() => makeClient().request("query Q { a }", {}));
      assertEqual(calls.count, 1, "client: 404(IP_NOT_ALLOWED)はリトライしない(IP登録が済むまで何度送っても同じ)");
    },
  );

  // 401も同様。
  await withFetch(
    async () => textResponse("unauthorized", 401),
    async (calls) => {
      await captureError(() => makeClient().request("query Q { a }", {}));
      assertEqual(calls.count, 1, "client: 401(AUTH_FAILED)はリトライしない");
    },
  );

  // 429は時間をおけば変わる —— 再試行する。
  await withFetch(
    async () => textResponse("slow down", 429),
    async (calls) => {
      await captureError(() => makeClient().request("query Q { a }", {}));
      assertEqual(calls.count, 2, "client: 429(RATE_LIMITED)は再試行する");
    },
  );

  // 非JSON応答は再送しても同じ —— リトライしない。
  await withFetch(
    async () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }),
    async (calls) => {
      await captureError(() => makeClient().request("query Q { a }", {}));
      assertEqual(calls.count, 1, "client: INVALID_RESPONSEはリトライしない");
    },
  );

  if (prev === undefined) delete process.env.MERCARI_MAX_RETRIES;
  else process.env.MERCARI_MAX_RETRIES = prev;
}

// ── §3.3「tokenをmessage/logへ出さない」 ────────────────────────────

async function testTokenNeverLeaks() {
  const statuses = [400, 401, 403, 404, 429, 500];
  for (const status of statuses) {
    await withFetch(
      async () => textResponse(`error body mentioning nothing secret`, status),
      async (calls) => {
        const err = (await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }))) as MercariApiError;
        assertTrue(!err.message.includes(FAKE_TOKEN), `client: HTTP ${status}のエラーメッセージにTOKENが含まれない`);
        assertTrue(!err.causeMessage.includes(FAKE_TOKEN), `client: HTTP ${status}のcauseMessageにTOKENが含まれない`);
        // 送信ヘッダにはもちろん載る(それが目的) — 検査しているのは戻り値・例外側。
        const headers = (calls.lastInit as { headers?: Record<string, string> } | undefined)?.headers ?? {};
        assertEqual(headers.Authorization, `Bearer ${FAKE_TOKEN}`, `client: HTTP ${status}でもAuthorizationヘッダは正しく組み立てられている`);
        assertEqual(headers["User-Agent"], `${FAKE_CLIENT}/0.0.0`, `client: HTTP ${status}でもUser-Agentを必ず送る(公式ドキュメントの必須要件)`);
      },
    );
  }

  // 巨大なエラー本文はログ・メッセージへ丸ごと流し込まない。
  const huge = "x".repeat(50_000);
  await withFetch(
    async () => textResponse(huge, 500),
    async () => {
      const err = (await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }))) as MercariApiError;
      assertTrue(err.causeMessage.length < 1_000, "client: 巨大なエラー本文は切り詰めてから保持する(実測でエッジは1MB超のHTMLを返し得る)");
      assertTrue(err.causeMessage.includes("省略"), "client: 切り詰めた場合はその旨が分かる");
    },
  );

  // 429のX-Ratelimit-Resetは秘密ではなく、再試行時刻の判断材料として残す。
  await withFetch(
    async () => textResponse("slow down", 429, { "x-ratelimit-reset": "1735689600" }),
    async () => {
      const err = (await captureError(() => makeClient().request("query Q { a }", {}, { disableRetry: true }))) as MercariApiError;
      assertTrue(err.causeMessage.includes("1735689600"), "client: 429のX-Ratelimit-Resetを診断情報として保持する");
    },
  );
}

// ── §3.3「validateMercariConnectionは必ず結果を返す」 ───────────────

async function testValidateNeverThrows() {
  const scenarios: Array<{ label: string; stub: FetchStub }> = [
    { label: "HTTP 404(IP未登録の疑い)", stub: async () => textResponse("Not Found\n", 404) },
    { label: "HTTP 401(TOKEN不正)", stub: async () => textResponse("unauthorized", 401) },
    { label: "HTTP 400", stub: async () => textResponse("bad request", 400) },
    { label: "非JSON応答", stub: async () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }) },
    { label: "ネットワーク例外", stub: async () => { throw new TypeError("fetch failed"); } },
    { label: "GraphQLエラー", stub: async () => jsonResponse({ errors: [{ message: "invalid" }] }) },
  ];

  for (const s of scenarios) {
    await withFetch(s.stub, async () => {
      const res = await validateMercariConnection({ token: FAKE_TOKEN, clientName: FAKE_CLIENT });
      assertTrue(res !== undefined && res !== null, `validateMercariConnection: ${s.label} でもundefinedを返さない`);
      assertEqual(typeof res.ok, "boolean", `validateMercariConnection: ${s.label} でもokが必ず真偽値`);
      assertEqual(res.ok, false, `validateMercariConnection: ${s.label} は失敗として返る`);
      assertTrue(typeof res.message === "string" && res.message.length > 0, `validateMercariConnection: ${s.label} でも日本語の説明が付く`);
      assertTrue(!res.message.includes(FAKE_TOKEN), `validateMercariConnection: ${s.label} の説明にTOKENが混ざらない`);
    });
  }

  await withFetch(
    async () => jsonResponse({ data: { productCategories: [] } }),
    async () => {
      const res = await validateMercariConnection({ token: FAKE_TOKEN, clientName: FAKE_CLIENT });
      assertEqual(res.ok, true, "validateMercariConnection: 正常応答は成功として返る");
    },
  );
}

// ── §3.4 保存可否の判断(保存デッドロックの解消) ─────────────────────

function testConnectionPolicy() {
  assertEqual(
    decideMercariSave({ validationOk: true, code: undefined, hasVerifiedExisting: false }),
    { save: true, verified: true, status: "CONNECTED" },
    "policy: 接続確認に成功したら検証済みとして保存する",
  );

  // ここが「保存デッドロック」の解消点。
  assertEqual(
    decideMercariSave({ validationOk: false, code: "IP_NOT_ALLOWED", hasVerifiedExisting: false }),
    { save: true, verified: false, status: "SAVED_UNVERIFIED" },
    "policy: 初回設定でIP未登録(404)なら、未検証として保存する(正しいTOKENが永久に保存できない状態を作らない)",
  );

  for (const code of ["NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED", "INVALID_RESPONSE", "UNKNOWN_REMOTE_ERROR", "REMOTE_VALIDATION_ERROR"] as MercariErrorCode[]) {
    assertEqual(
      decideMercariSave({ validationOk: false, code, hasVerifiedExisting: false }),
      { save: true, verified: false, status: "SAVED_UNVERIFIED" },
      `policy: ${code}はTOKENの正否を判定できないので、初回は未検証として保存する`,
    );
  }

  // TOKENが拒否された場合は保存しない —— 保存すると「設定済み」表示が嘘になる。
  for (const code of ["AUTH_FAILED", "BAD_REQUEST"] as MercariErrorCode[]) {
    assertEqual(
      decideMercariSave({ validationOk: false, code, hasVerifiedExisting: false }),
      { save: false, reason: "TOKEN_REJECTED" },
      `policy: ${code}(TOKENそのものが拒否された)は保存しない`,
    );
  }

  // §92: 既存の検証済み設定は、検証できなかった入力で上書きしない。
  assertEqual(
    decideMercariSave({ validationOk: false, code: "IP_NOT_ALLOWED", hasVerifiedExisting: true }),
    { save: false, reason: "PRESERVE_VERIFIED_EXISTING" },
    "policy: 既に接続確認済みの設定があるなら、検証できなかった入力で上書きしない(§92)",
  );
  assertEqual(
    decideMercariSave({ validationOk: false, code: "NETWORK_ERROR", hasVerifiedExisting: true }),
    { save: false, reason: "PRESERVE_VERIFIED_EXISTING" },
    "policy: ネットワーク障害中の入力で既存の有効な設定を壊さない",
  );
  // ただし検証に成功したなら、既存設定があっても更新してよい(TOKENの入れ替え)。
  assertEqual(
    decideMercariSave({ validationOk: true, code: undefined, hasVerifiedExisting: true }),
    { save: true, verified: true, status: "CONNECTED" },
    "policy: 接続確認が取れた新しいTOKENは、既存設定があっても上書き保存する",
  );

  assertTrue(isMercariTokenRejected("AUTH_FAILED"), "policy: AUTH_FAILEDはTOKEN拒否");
  assertTrue(isMercariTokenRejected("BAD_REQUEST"), "policy: BAD_REQUESTはTOKEN拒否");
  assertTrue(!isMercariTokenRejected("IP_NOT_ALLOWED"), "policy: IP_NOT_ALLOWEDはTOKEN拒否ではない(認証を評価する前に404が返るため)");
  assertTrue(!isMercariTokenRejected(undefined), "policy: 分類不明はTOKEN拒否と決めつけない");

  assertTrue(isMercariRetryableForUser("TIMEOUT"), "policy: TIMEOUTは再試行を促してよい");
  assertTrue(!isMercariRetryableForUser("IP_NOT_ALLOWED"), "policy: IP_NOT_ALLOWEDは再試行しても直らない(IP登録が要る)");
  assertTrue(!isMercariRetryableForUser("AUTH_FAILED"), "policy: AUTH_FAILEDは再試行しても直らない");
}

// ── エラー分類そのもの ──────────────────────────────────────────────

function testErrorTaxonomy() {
  assertEqual(classifyHttpStatus(400), "BAD_REQUEST", "classifyHttpStatus: 400 -> BAD_REQUEST");
  assertEqual(classifyHttpStatus(404), "IP_NOT_ALLOWED", "classifyHttpStatus: 404 -> IP_NOT_ALLOWED");
  assertEqual(classifyForbiddenError("ip blocked"), "IP_NOT_ALLOWED", "classifyForbiddenError: IP文言を拾う");
  assertEqual(classifyGraphQLErrors([{ message: "rate limit exceeded" }]), "RATE_LIMITED", "classifyGraphQLErrors: レート制限を拾う");

  assertTrue(isRetryableMercariErrorCode("TIMEOUT"), "isRetryableMercariErrorCode: TIMEOUTはリトライ対象");
  assertTrue(!isRetryableMercariErrorCode("BAD_REQUEST"), "isRetryableMercariErrorCode: BAD_REQUESTはリトライ対象外");
  assertTrue(!isRetryableMercariErrorCode("INVALID_RESPONSE"), "isRetryableMercariErrorCode: INVALID_RESPONSEはリトライ対象外");

  // §6.7: すべての分類に、技術者でなくても読める日本語の説明がある。
  const codes: MercariErrorCode[] = [
    "CONFIG_REQUIRED",
    "AUTH_FAILED",
    "BAD_REQUEST",
    "IP_NOT_ALLOWED",
    "RATE_LIMITED",
    "REMOTE_VALIDATION_ERROR",
    "NETWORK_ERROR",
    "TIMEOUT",
    "INVALID_RESPONSE",
    "UNKNOWN_REMOTE_ERROR",
  ];
  for (const code of codes) {
    const label = MERCARI_ERROR_LABEL[code];
    assertTrue(typeof label === "string" && label.length > 0, `MERCARI_ERROR_LABEL: ${code}に日本語の説明がある`);
    assertTrue(!/undefined|Error:|stack/i.test(label), `MERCARI_ERROR_LABEL: ${code}の文言に技術的な残骸が混ざらない`);
  }

  // §3.6: IP制限は「こちらからは確認できない」ので断定しない。
  assertTrue(MERCARI_ERROR_LABEL.IP_NOT_ALLOWED.includes("可能性"), "IP_NOT_ALLOWEDの文言: 断定せず「可能性」として伝える");
}

// ── 環境変数の読み取り(不正値でリクエストが壊れない) ────────────────

function testEnvParsing() {
  assertEqual(positiveIntFromEnv(undefined, 15000), 15000, "positiveIntFromEnv: 未設定なら既定値");
  assertEqual(positiveIntFromEnv("", 15000), 15000, "positiveIntFromEnv: 空文字なら既定値");
  assertEqual(positiveIntFromEnv("abc", 15000), 15000, "positiveIntFromEnv: 数値でなければ既定値(NaNをsetTimeoutへ渡さない)");
  assertEqual(positiveIntFromEnv("0", 15000), 15000, "positiveIntFromEnv: 0は即時abortになるため既定値へ倒す");
  assertEqual(positiveIntFromEnv("-5", 15000), 15000, "positiveIntFromEnv: 負値は既定値へ倒す");
  assertEqual(positiveIntFromEnv("3000", 15000), 3000, "positiveIntFromEnv: 正しい値はそのまま使う");

  assertEqual(nonNegativeIntFromEnv("0", 3), 0, "nonNegativeIntFromEnv: 0は有効な設定(リトライしない)");
  assertEqual(nonNegativeIntFromEnv("abc", 3), 3, "nonNegativeIntFromEnv: 数値でなければ既定値");
  assertEqual(nonNegativeIntFromEnv("-1", 3), 3, "nonNegativeIntFromEnv: 負値は既定値");

  assertEqual(extractGraphQLOperationName("query ProductCategories { a }"), "ProductCategories", "extractGraphQLOperationName: 操作名を取り出す");
}

async function main() {
  testErrorTaxonomy();
  testConnectionPolicy();
  testEnvParsing();
  await testHttpStatusHandling();
  await testNonJsonAndMalformedResponses();
  await testNetworkAndTimeout();
  await testRetryBehaviour();
  await testTokenNeverLeaks();
  await testValidateNeverThrows();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-mercari.ts crashed:", err);
  process.exit(1);
});

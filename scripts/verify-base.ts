/**
 * BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASE商品作成/
 * 編集アダプタの純粋ロジック(lib/listing/base/errors.ts)の
 * standalone verification。
 *
 * Run with: npm run verify:base
 * (createBaseProduct/updateBaseProduct自体はAWS/lib/base/oauth.ts経由の
 * ネットワーク呼び出しを含むため、他のadapter系ファイルと同じ方針で
 * unit test対象外 — ここではエラー分類の純粋関数のみを検証する。)
 */
import { classifyBaseHttpStatus, BaseListingApiError } from "@/lib/listing/base/errors";
import { buildRedirectUriFromHost, resolveAppOrigin, resolveRedirectUri, OAUTH_CALLBACK_PATH } from "@/lib/base/redirectUri";
import { resolveScope, READ_ONLY_SCOPE, READ_WRITE_SCOPE } from "@/lib/base/scope";
import { unwrapDataResult, AmplifyDataError } from "@/lib/amplify/dataResult";

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

function testClassifyBaseHttpStatus() {
  assertEqual(classifyBaseHttpStatus(401, "unauthorized").code, "AUTH_FAILED", "classifyBaseHttpStatus: 401 -> AUTH_FAILED");
  assertEqual(classifyBaseHttpStatus(429, "rate limited").code, "RATE_LIMITED", "classifyBaseHttpStatus: 429 -> RATE_LIMITED");
  assertEqual(classifyBaseHttpStatus(400, "bad request").code, "REMOTE_VALIDATION_ERROR", "classifyBaseHttpStatus: 400 -> REMOTE_VALIDATION_ERROR");
  assertEqual(classifyBaseHttpStatus(422, "invalid").code, "REMOTE_VALIDATION_ERROR", "classifyBaseHttpStatus: 422 -> REMOTE_VALIDATION_ERROR");
  assertEqual(classifyBaseHttpStatus(500, "server error").code, "UNKNOWN_REMOTE_ERROR", "classifyBaseHttpStatus: 500 -> UNKNOWN_REMOTE_ERROR");
  assertEqual(classifyBaseHttpStatus(503, "unavailable").code, "UNKNOWN_REMOTE_ERROR", "classifyBaseHttpStatus: 503 -> UNKNOWN_REMOTE_ERROR");

  const err = classifyBaseHttpStatus(401, "token expired");
  const isRealError = err instanceof BaseListingApiError && err instanceof Error;
  assertEqual(isRealError, true, "classifyBaseHttpStatus: returns a real BaseListingApiError (instanceof Error)");
  assertEqual(err.causeMessage.includes("token expired"), true, "classifyBaseHttpStatus: causeMessage keeps the technical detail separate from the user-facing message");
}


/**
 * redirect_uri は「BASE Developersへ登録した値」「認可URLの値」
 * 「トークン交換で送る値」の3つが完全一致しなければならず、
 * ずれたときの `redirect_uri_mismatch` は原因が最も分かりにくい。
 * その一致を保証しているのがこの関数なので、固定して壊れないようにする。
 */
function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

function testRedirectUri() {
  const previous = process.env.BASE_REDIRECT_URI;
  delete process.env.BASE_REDIRECT_URI;

  // Amplify HostingのSSRはCloudFrontの背後にあり、ブラウザが実際に見て
  // いるホストは x-forwarded-host に入る。ここを取り違えると、内部の
  // ホスト名でredirect_uriを組み立ててしまい必ずmismatchになる。
  assertEqual(
    resolveAppOrigin(makeRequest("https://internal.local/api/base/oauth/start", { "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" })),
    "https://app.example.com",
    "resolveAppOrigin: x-forwarded-host を host より優先する",
  );
  assertEqual(
    resolveAppOrigin(makeRequest("https://internal.local/x", { "x-forwarded-host": "a.example.com, b.example.com" })),
    "https://a.example.com",
    "resolveAppOrigin: x-forwarded-host が複数値なら先頭を使う",
  );
  assertEqual(
    resolveAppOrigin(makeRequest("http://localhost:3000/x", { host: "localhost:3000" })),
    "http://localhost:3000",
    "resolveAppOrigin: localhost は http のまま扱う",
  );
  assertEqual(
    resolveRedirectUri(makeRequest("https://internal.local/x", { "x-forwarded-host": "app.example.com" })),
    "https://app.example.com" + OAUTH_CALLBACK_PATH,
    "resolveRedirectUri: 実際のホスト + コールバックパス",
  );
  assertEqual(
    buildRedirectUriFromHost("app.example.com"),
    "https://app.example.com" + OAUTH_CALLBACK_PATH,
    "buildRedirectUriFromHost: 画面表示用の値が resolveRedirectUri と一致する",
  );
  assertEqual(buildRedirectUriFromHost(null), null, "buildRedirectUriFromHost: ホスト不明なら null（推測した値を表示しない）");

  // 明示的な上書きは全経路で同じように効かなければならない。
  // 片方だけ効くと、認可URLとトークン交換で値がずれる。
  process.env.BASE_REDIRECT_URI = "https://custom.example.com/cb";
  assertEqual(
    resolveRedirectUri(makeRequest("https://internal.local/x", { "x-forwarded-host": "app.example.com" })),
    "https://custom.example.com/cb",
    "resolveRedirectUri: BASE_REDIRECT_URI が最優先",
  );
  assertEqual(
    buildRedirectUriFromHost("app.example.com"),
    "https://custom.example.com/cb",
    "buildRedirectUriFromHost: 上書き時も同じ値を表示する（画面と実際の送信値がずれない）",
  );

  if (previous === undefined) delete process.env.BASE_REDIRECT_URI;
  else process.env.BASE_REDIRECT_URI = previous;
}

/**
 * BASE Developers側で許可されていない権限を要求すると認可自体が通らず、
 * 読み取りすらできなくなる。read-onlyで繋げる逃げ道を必ず残す。
 */
function testScope() {
  const previous = process.env.BASE_SCOPES;
  delete process.env.BASE_SCOPES;

  assertEqual(resolveScope(true), READ_WRITE_SCOPE, "resolveScope: write要求ONなら read_items write_items");
  assertEqual(resolveScope(false), READ_ONLY_SCOPE, "resolveScope: write要求OFFなら read_items のみ");
  assertEqual(READ_ONLY_SCOPE.includes("write"), false, "resolveScope: read-onlyスコープに write が混ざっていない");

  process.env.BASE_SCOPES = "read_items read_users";
  assertEqual(resolveScope(true), "read_items read_users", "resolveScope: BASE_SCOPES が最優先");

  if (previous === undefined) delete process.env.BASE_SCOPES;
  else process.env.BASE_SCOPES = previous;
}

/**
 * Amplify Dataの「拒否されても例外を投げない」挙動を握りつぶさない。
 *
 * これは実機で起きた不具合そのもの: OAuth認可もtoken交換も成功して
 * いたのに、tokenの書き込みがAppSyncに拒否され、BaseOAuthTokenは0行の
 * まま管理画面が「連携が完了しました」と表示していた。原因は
 * `const { data } = await client.models.X.create(...)` が errors を
 * 見ていなかったこと。
 */
function testUnwrapDataResult() {
  const messages = { unauthorized: "権限がありません。", failed: "失敗しました。" };

  assertEqual(unwrapDataResult({ data: { id: "x" } }, "T.get", messages), { id: "x" }, "unwrapDataResult: errorsが無ければdataをそのまま返す");
  assertEqual(unwrapDataResult({ data: null, errors: [] }, "T.get", messages), null, "unwrapDataResult: 空のerrors配列は成功として扱う（行が無いだけ）");

  // 拒否は必ず例外にする —— ここが「保存できたつもり」を防ぐ唯一の砦。
  let thrown: unknown = null;
  try {
    unwrapDataResult({ data: null, errors: [{ errorType: "Unauthorized", message: "Not Authorized to access createBaseOAuthToken" }] }, "T.create", messages);
  } catch (err) {
    thrown = err;
  }
  assertEqual(thrown instanceof AmplifyDataError, true, "unwrapDataResult: 認可拒否は例外になる（黙って成功扱いにしない）");
  assertEqual((thrown as AmplifyDataError).unauthorized, true, "unwrapDataResult: 認可拒否を unauthorized=true と分類する");
  assertEqual((thrown as AmplifyDataError).message, messages.unauthorized, "unwrapDataResult: 認可拒否には権限の文言を出す");
  assertEqual((thrown as AmplifyDataError).errorTypes, ["Unauthorized"], "unwrapDataResult: errorTypeを監査用に保持する");

  // errorType が無く message にだけ現れる場合もある。
  let thrown2: unknown = null;
  try {
    unwrapDataResult({ data: null, errors: [{ message: "Not authorized" }] }, "T.update", messages);
  } catch (err) {
    thrown2 = err;
  }
  assertEqual((thrown2 as AmplifyDataError).unauthorized, true, "unwrapDataResult: messageだけの認可拒否も検出する");

  // 認可以外の失敗は、時間をおけば直る可能性がある別分類。
  let thrown3: unknown = null;
  try {
    unwrapDataResult({ data: null, errors: [{ errorType: "DynamoDB:ProvisionedThroughputExceeded", message: "throttled" }] }, "T.create", messages);
  } catch (err) {
    thrown3 = err;
  }
  assertEqual((thrown3 as AmplifyDataError).unauthorized, false, "unwrapDataResult: 認可以外の失敗は unauthorized=false");
  assertEqual((thrown3 as AmplifyDataError).message, messages.failed, "unwrapDataResult: 認可以外には一時的障害の文言を出す");

  // 秘密値を持つモデルからも呼ばれる。dataの中身がメッセージへ漏れないこと。
  let thrown4: unknown = null;
  try {
    unwrapDataResult({ data: { accessToken: "SECRET-VALUE-SHOULD-NOT-LEAK" }, errors: [{ errorType: "Unauthorized" }] }, "T.get", messages);
  } catch (err) {
    thrown4 = err;
  }
  assertEqual(
    (thrown4 as Error).message.includes("SECRET-VALUE-SHOULD-NOT-LEAK"),
    false,
    "unwrapDataResult: エラーメッセージにdataの中身を含めない",
  );
}

function main() {
  testClassifyBaseHttpStatus();
  testRedirectUri();
  testScope();
  testUnwrapDataResult();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();

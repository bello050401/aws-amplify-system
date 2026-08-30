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

function main() {
  testClassifyBaseHttpStatus();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();

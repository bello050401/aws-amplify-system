import test from "node:test";
import assert from "node:assert/strict";
import { parseRuntimeSession } from "./webHttpRuntime.ts";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
const now = Date.parse("2026-10-13T16:00:00Z");
const session = { schemaVersion: 1, shopId: WEB_HTTP_SHOP_ID,
  authenticatedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
  opaqueMaterial: JSON.stringify({ cookieHeader: "id_token=fixture; __cf_bm=fixture-cf" }) };
test("runtime accepts a bounded session for only the configured shop", () => {
  assert.equal(parseRuntimeSession(session, now).expiresAtMs, now + 3_600_000);
  for (const invalid of [null, {}, { ...session, shopId: "other" },
    { ...session, authenticatedAt: new Date(now + 1).toISOString() },
    { ...session, expiresAt: new Date(now + 39_999).toISOString() }])
    assert.equal(parseRuntimeSession(invalid, now), null);
});
test("runtime rejects header injection, duplicate cookies and unrelated credentials", () => {
  for (const cookieHeader of ["id_token=one\r\nHost: other", "id_token=one; id_token=two",
    "id_token=one; unrelated=secret", "__cf_bm=alone", "id_token=", "id_token=" + "a".repeat(32_768)])
    assert.equal(parseRuntimeSession({ ...session, opaqueMaterial: JSON.stringify({ cookieHeader }) }, now), null);
});

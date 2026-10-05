import assert from "node:assert/strict";
import test from "node:test";
import { mercariDirectReadProofReportedAt,
  mercariPcConnectionLabels, mercariPcConnectionStatus } from "./connectionStatus.ts";

const result = (status, visibility = null, recordedAt = "2026-10-04T03:00:00.000Z") => ({
  attemptId: "01111111-1111-4111-8111-111111111111", recordedAt, status,
  reasonCode: null, fields: {}, visibility, identity: visibility ? "MATCH" : null,
});

test("no PC report leaves Shops login unconfirmed", () => {
  assert.deepEqual(mercariPcConnectionStatus([]), {
    pc: "NO_REPORT", shops: "LOGIN_UNCONFIRMED", recordedAt: null,
  });
});

test("unfetched, failed, and successful empty lookups have distinct labels", () => {
  assert.deepEqual(mercariPcConnectionLabels("UNFETCHED", []), {
    pc: "未確認（記録未取得）", shops: "未確認（記録未取得）", recordedAt: null,
  });
  assert.deepEqual(mercariPcConnectionLabels("FAILED", []), {
    pc: "取得失敗", shops: "取得失敗", recordedAt: null,
  });
  assert.deepEqual(mercariPcConnectionLabels("READY", []), {
    pc: "未接続（この依頼の報告なし）", shops: "ログイン未確認", recordedAt: null,
  });
});

test("a PC report without a trusted product read does not confirm Shops login", () => {
  for (const status of ["CONNECTOR_NOT_CONFIGURED", "UNKNOWN", "IDENTITY_MISMATCH"])
    assert.equal(mercariPcConnectionStatus([result(status)]).shops, "LOGIN_UNCONFIRMED");
  assert.equal(mercariPcConnectionStatus([result("CONNECTOR_NOT_CONFIGURED")]).pc,
    "REPORT_RECEIVED");
});

test("re-authentication takes precedence over an older confirmed read", () => {
  assert.deepEqual(mercariPcConnectionStatus([
    result("CORE_FIELDS_MATCH", "PRIVATE_OBSERVED", "2026-10-04T02:00:00.000Z"),
    result("AUTH_REQUIRED"),
  ]), { pc: "REPORT_RECEIVED", shops: "REAUTH_REQUIRED",
    recordedAt: "2026-10-04T03:00:00.000Z" });
});

test("only an accepted product observation confirms a past Shops read", () => {
  assert.equal(mercariPcConnectionStatus([result("INCOMPLETE", "PRIVATE_OBSERVED")]).shops,
    "READ_CONFIRMED");
  assert.equal(mercariPcConnectionStatus([result("NOT_PRIVATE", "NOT_PRIVATE")]).shops,
    "READ_CONFIRMED");
  assert.equal(mercariPcConnectionStatus([result("INCOMPLETE", "UNOBSERVED")]).shops,
    "LOGIN_UNCONFIRMED");
  assert.equal(mercariPcConnectionStatus([{ ...result("DIFFERENT"), identity: "MATCH",
    fields: { title: "DIFFERENT" } }]).shops, "READ_CONFIRMED");
  assert.equal(mercariPcConnectionStatus([{ ...result("INCOMPLETE"), identity: "MATCH",
    fields: { priceYen: "MATCH" } }]).shops, "READ_CONFIRMED");
  assert.equal(mercariPcConnectionStatus([{ ...result("INCOMPLETE", "PRIVATE_OBSERVED"),
    identity: "UNOBSERVED" }]).shops, "LOGIN_UNCONFIRMED");
});

test("a saved direct HTTP proof is displayed separately from login state", () => {
  assert.deepEqual(mercariPcConnectionStatus([{ ...result("DIRECT_HTTP_READ_CONFIRMED"),
    reasonCode: "PINNED_HTTP_200_MATCHED" }]), {
    pc: "REPORT_RECEIVED", shops: "LOGIN_UNCONFIRMED", recordedAt: "2026-10-04T03:00:00.000Z",
  });
  assert.equal(mercariDirectReadProofReportedAt([{ ...result("DIRECT_HTTP_READ_CONFIRMED"),
    reasonCode: "PINNED_HTTP_200_MATCHED" }]), "2026-10-04T03:00:00.000Z");
  assert.equal(mercariPcConnectionStatus([{ ...result("DIRECT_HTTP_READ_CONFIRMED"),
    reasonCode: null }]).shops, "LOGIN_UNCONFIRMED");
});

test("a delayed old HTTP proof cannot override a later authentication failure", () => {
  const rows = [
    { ...result("DIFFERENT", "PRIVATE_OBSERVED", "2026-10-04T11:36:30.506Z"),
      identity: "MATCH", fields: { title: "DIFFERENT" } },
    result("AUTH_REQUIRED", null, "2026-10-05T10:00:00.000Z"),
    { ...result("DIRECT_HTTP_READ_CONFIRMED", null, "2026-10-05T12:00:00.000Z"),
      reasonCode: "PINNED_HTTP_200_MATCHED" },
  ];
  assert.deepEqual(mercariPcConnectionStatus(rows), {
    pc: "REPORT_RECEIVED", shops: "REAUTH_REQUIRED",
    recordedAt: "2026-10-05T12:00:00.000Z",
  });
  assert.equal(mercariDirectReadProofReportedAt(rows), "2026-10-05T12:00:00.000Z");
});

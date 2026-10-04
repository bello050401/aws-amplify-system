import assert from "node:assert/strict";
import test from "node:test";
import { mercariPcConnectionStatus } from "./connectionStatus.ts";

const result = (status, visibility = null, recordedAt = "2026-10-04T03:00:00.000Z") => ({
  attemptId: "01111111-1111-4111-8111-111111111111", recordedAt, status,
  reasonCode: null, fields: {}, visibility, identity: visibility ? "MATCH" : null,
});

test("no PC report leaves Shops login unconfirmed", () => {
  assert.deepEqual(mercariPcConnectionStatus([]), {
    pc: "NO_REPORT", shops: "LOGIN_UNCONFIRMED", recordedAt: null,
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

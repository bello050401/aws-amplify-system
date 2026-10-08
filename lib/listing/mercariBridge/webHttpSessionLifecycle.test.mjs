import test from "node:test";
import assert from "node:assert/strict";
import { checkWebHttpSession, saveVerifiedWebHttpSession } from
  "./webHttpSessionLifecycle.ts";

const input = {
  shopId: "evkhihBFFNn5hukMS9s36H",
  ownerSub: "owner_123",
  sessionId: "fef2b7ee-cf21-429f-99bf-9439eafab3af",
  authenticatedAt: "2026-10-09T00:00:00.000Z",
  expiresAt: null,
  opaqueMaterial: "mock-secret-never-returned",
};
const at = value => () => Date.parse(value);
function memoryStore() {
  let value = null;
  let writes = 0;
  return {
    read: async () => value,
    write: async next => { value = { ...next }; writes++; },
    stored: () => value,
    writes: () => writes,
  };
}

test("verified human session is persisted and reused without a fixed lifetime", async () => {
  const store = memoryStore();
  const saved = await saveVerifiedWebHttpSession(input, store,
    async material => material === input.opaqueMaterial ? "VALID" : "UNKNOWN",
    at("2026-10-09T00:01:00.000Z"));
  assert.equal(saved.status, "READY_FOR_READONLY_PREFLIGHT");
  assert.equal(store.writes(), 1);
  const later = await checkWebHttpSession(input.shopId, input.ownerSub,
    store, async () => "VALID", at("2026-10-30T00:00:00.000Z"));
  assert.equal(later.status, "READY_FOR_READONLY_PREFLIGHT");
  for (const result of [saved, later]) {
    assert.equal(result.allowHttpWrite, false);
    assert.equal(JSON.stringify(result).includes(input.opaqueMaterial), false);
  }
});

test("known expiry stops before probing; actual expiry asks for re-login", async () => {
  const store = memoryStore();
  await store.write({ schemaVersion: 1, ...input,
    expiresAt: "2026-10-09T00:05:00.000Z" });
  let probes = 0;
  const expiredByTime = await checkWebHttpSession(input.shopId,
    input.ownerSub, store, async () => { probes++; return "VALID"; },
    at("2026-10-09T00:05:00.000Z"));
  assert.equal(expiredByTime.status, "AUTH_REQUIRED");
  assert.equal(expiredByTime.reauthenticationRequired, true);
  assert.equal(probes, 0);
  await store.write({ schemaVersion: 1, ...input, expiresAt: null });
  const expiredByProbe = await checkWebHttpSession(input.shopId,
    input.ownerSub, store, async () => "EXPIRED",
    at("2026-10-09T00:05:00.000Z"));
  assert.equal(expiredByProbe.status, "AUTH_REQUIRED");
  assert.equal(expiredByProbe.allowHttpWrite, false);
});

test("unknown auth, wrong owner, and storage errors fail closed", async () => {
  const store = memoryStore();
  await store.write({ schemaVersion: 1, ...input });
  const unknown = await checkWebHttpSession(input.shopId, input.ownerSub,
    store, async () => { throw Error("secret-like error"); },
    at("2026-10-09T00:01:00.000Z"));
  assert.equal(unknown.status, "AUTH_UNVERIFIED");
  assert.equal(unknown.reauthenticationRequired, false);
  assert.equal(JSON.stringify(unknown).includes("secret-like"), false);
  const otherOwner = await checkWebHttpSession(input.shopId, "other_owner",
    store, async () => { throw Error("should not probe"); },
    at("2026-10-09T00:01:00.000Z"));
  assert.equal(otherOwner.status, "AUTH_REQUIRED");
  const unavailable = await checkWebHttpSession(input.shopId, input.ownerSub,
    { read: async () => { throw Error("secret data"); }, write: async () => {} },
    async () => "VALID", at("2026-10-09T00:01:00.000Z"));
  assert.equal(unavailable.status, "STORAGE_UNAVAILABLE");
  assert.equal(JSON.stringify(unavailable).includes("secret data"), false);
});

test("unverified capture never reaches the secret store", async () => {
  const store = memoryStore();
  const failed = await saveVerifiedWebHttpSession(input, store,
    async () => "UNKNOWN", at("2026-10-09T00:01:00.000Z"));
  assert.equal(failed.status, "AUTH_UNVERIFIED");
  assert.equal(store.writes(), 0);
  const wrongShop = await saveVerifiedWebHttpSession({ ...input, shopId: "other" },
    store, async () => "VALID", at("2026-10-09T00:01:00.000Z"));
  assert.equal(wrongShop.status, "INVALID_INPUT");
  assert.equal(store.writes(), 0);
});

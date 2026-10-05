import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptPrivateCreateTrialEvent, privateCreateTrialForOwner,
  PrivateCreateTrialError } from "./privateCreateTrial.ts";

const principal = "owner@example.invalid";
const attemptId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const claim = { schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_CLAIM", attemptId,
  claimedAt: "2026-10-05T13:30:00.000Z",
  inventoryId: "c9ee4ea7-070f-491c-bd4c-c1547cb73436",
  inventoryCode: "B005757", shopId: "evkhihBFFNn5hukMS9s36H",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343",
  priceYen: 98000, listingConfirmed: false };
const result = { ...claim, kind: "BELLO_PRIVATE_CREATE_UI_ATTEMPT",
  outcome: "UNVERIFIED", reasonCode: "NETWORK_NOT_OBSERVED" };
const clock = "2026-10-05T13:31:00.000Z";
function repository() {
  const rows = new Map();
  return { rows, getEvent: async id => rows.get(id) ?? null,
    createEvent: async row => {
      if (rows.has(row.eventId)) throw Error("conditional create failed");
      rows.set(row.eventId, row);
    } };
}
const code = expected => error => error instanceof PrivateCreateTrialError &&
  error.code === expected;

test("pinned claim is immutable, idempotent, and an unverified result stays separate", async () => {
  const repo = repository();
  await assert.rejects(acceptPrivateCreateTrialEvent(result, principal, repo, clock),
    code("RESULT_BEFORE_CLAIM"));
  const savedClaim = await acceptPrivateCreateTrialEvent(claim, principal, repo, clock);
  assert.equal(savedClaim.status, "CLAIMED");
  assert.equal(savedClaim.kind, "CLAIM");
  assert.equal(await acceptPrivateCreateTrialEvent(claim, principal, repo, clock), savedClaim);
  await assert.rejects(acceptPrivateCreateTrialEvent({ ...claim,
    attemptId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" }, principal, repo, clock),
  code("EVENT_CONFLICT"));
  const savedResult = await acceptPrivateCreateTrialEvent(result, principal, repo, clock);
  assert.equal(savedResult.status, "UI_ATTEMPT_UNVERIFIED");
  assert.equal(savedResult.reasonCode, "NETWORK_NOT_OBSERVED");
  assert.equal(Object.hasOwn(savedResult, "remoteId"), false);
  assert.equal(await acceptPrivateCreateTrialEvent(result, principal, repo, clock), savedResult);
  await assert.rejects(acceptPrivateCreateTrialEvent({ ...result,
    claimedAt: "2026-10-05T13:30:01.000Z" }, principal, repo, clock),
  code("RESULT_BEFORE_CLAIM"));
  assert.deepEqual(await privateCreateTrialForOwner(principal, repo), {
    claim: { attemptId, recordedAt: clock },
    result: { status: "UI_ATTEMPT_UNVERIFIED",
      reasonCode: "NETWORK_NOT_OBSERVED", recordedAt: clock },
  });
  await assert.rejects(privateCreateTrialForOwner("other@example.invalid", repo),
    code("OWNER_REQUIRED"));
  repo.rows.set(savedResult.eventId, { ...savedResult, shopId: "other" });
  await assert.rejects(privateCreateTrialForOwner(principal, repo),
    code("EVENT_CONFLICT"));
});

test("changed targets, extra data, and success claims cannot be imported", async () => {
  const repo = repository();
  for (const bad of [
    { ...claim, shopId: "other" }, { ...claim, skuCode: "OTHER" },
    { ...claim, priceYen: 26500 }, { ...claim, listingConfirmed: true },
    { ...claim, newRemoteId: "unexpected" },
    { ...result, outcome: "MATCHED" }, { ...result, reasonCode: "MATCHED" },
    { ...result, httpStatus: 200 },
  ]) await assert.rejects(acceptPrivateCreateTrialEvent(bad, principal, repo, clock),
    code("INVALID_INPUT"));
  assert.equal(repo.rows.size, 0);
});

import assert from "node:assert/strict";
import { withBoundNextEngineRead } from "../lib/listing/nextEngine/boundRead";

async function main() {
  const binding = { clientId: "synthetic-id", clientSecret: "synthetic-secret",
    expectedCompanyNeId: "synthetic-company", credentialVersionId: "synthetic-version" };
  const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  let current = binding;
  const services = {
    configuration: async () => current,
    readTokens: async () => tokens,
    saveTokens: async (next: typeof tokens) => { saved.push(next); },
  };
  assert.equal(await withBoundNextEngineRead(async (pair, persist) => {
    assert.deepEqual(pair, tokens);
    await persist({ accessToken: "rotated-a", refreshToken: "rotated-r" });
    return "read-only-result";
  }, services), "read-only-result");
  assert.deepEqual(saved, [{ accessToken: "rotated-a", refreshToken: "rotated-r" }]);

  let called = false;
  let reads = 0;
  await assert.rejects(withBoundNextEngineRead(async () => { called = true; }, {
    ...services,
    configuration: async () => ++reads === 1 ? binding : { ...binding, expectedCompanyNeId: "other-company" },
  }));
  assert.equal(called, false);
  await assert.rejects(withBoundNextEngineRead(async (_pair, persist) => {
    current = { ...binding, credentialVersionId: "new-version" };
    await persist({ accessToken: "x", refreshToken: "y" });
  }, services));
  assert.equal(saved.length, 1);
  current = binding;
  await assert.rejects(withBoundNextEngineRead(async () => {
    current = { ...binding, clientId: "different-client" };
    return "must-not-return";
  }, services));
  console.log("Next Engine bound read: company and credential changes prevent request/save/return.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

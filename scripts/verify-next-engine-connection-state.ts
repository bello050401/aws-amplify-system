import assert from "node:assert/strict";
import { getNextEngineConnectionState } from "../lib/listing/nextEngine/connectionState";

const config = { clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456", credentialVersionId: "version-a" };
const pair = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };

async function main() {
  assert.equal(await getNextEngineConnectionState({ configuration: async () => null, readTokens: async () => { throw new Error("unexpected"); } }), "CONFIGURATION_REQUIRED");
  assert.equal(await getNextEngineConnectionState({ configuration: async () => config, readTokens: async () => null }), "AWAITING_LAUNCH");
  assert.equal(await getNextEngineConnectionState({ configuration: async () => config, readTokens: async () => pair }), "CONNECTED");
  const reasons = [
    ["EMPTY", "AWAITING_LAUNCH"],
    ["CREDENTIAL_VERSION_MISMATCH", "TOKEN_VERSION_MISMATCH"],
    ["COMPANY_MISMATCH", "TOKEN_COMPANY_MISMATCH"],
    ["INVALID_FORMAT", "TOKEN_FORMAT_INVALID"],
    ["READ_ERROR", "TOKEN_READ_UNAVAILABLE"],
    ["REFERENCE_INVALID", "TOKEN_REFERENCE_INVALID"],
  ] as const;
  for (const [tokenStatus, expected] of reasons) {
    assert.equal(await getNextEngineConnectionState({ configuration: async () => config, inspectTokens: async () => tokenStatus }), expected);
  }
  let reads = 0;
  assert.equal(await getNextEngineConnectionState({
    configuration: async () => ++reads === 1 ? config : { ...config, credentialVersionId: "version-b" },
    readTokens: async () => pair,
  }), "APP_CONFIGURATION_CHANGED", "Configuration change during status read must not appear connected");
  assert.equal(await getNextEngineConnectionState({ configuration: async () => { throw new Error("synthetic-secret-detail"); }, readTokens: async () => pair }), "SECRET_UNAVAILABLE");
  console.log("Next Engine connection state: configuration, secret failure and version race passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

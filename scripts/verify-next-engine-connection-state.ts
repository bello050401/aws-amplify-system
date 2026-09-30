import assert from "node:assert/strict";
import { getNextEngineConnectionState } from "../lib/listing/nextEngine/connectionState";

const config = { clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456", credentialVersionId: "version-a" };
const pair = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };

async function main() {
  assert.equal(await getNextEngineConnectionState({ configuration: async () => null, readTokens: async () => { throw new Error("unexpected"); } }), "CONFIGURATION_REQUIRED");
  assert.equal(await getNextEngineConnectionState({ configuration: async () => config, readTokens: async () => null }), "AWAITING_LAUNCH");
  assert.equal(await getNextEngineConnectionState({ configuration: async () => config, readTokens: async () => pair }), "CONNECTED");
  let reads = 0;
  assert.equal(await getNextEngineConnectionState({
    configuration: async () => ++reads === 1 ? config : { ...config, credentialVersionId: "version-b" },
    readTokens: async () => pair,
  }), "AWAITING_LAUNCH", "Configuration change during status read must not appear connected");
  assert.equal(await getNextEngineConnectionState({ configuration: async () => { throw new Error("synthetic-secret-detail"); }, readTokens: async () => pair }), "SECRET_UNAVAILABLE");
  console.log("Next Engine connection state: configuration, secret failure and version race passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

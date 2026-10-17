import assert from "node:assert/strict";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { createAWSCredentialsAndIdentityIdProvider, runWithAmplifyServerContext } from "aws-amplify/adapter-core";
import { userPoolServerConfig } from "../lib/amplify/userPoolServerConfig";

async function main() {
  const original = { Auth: { Cognito: {
    userPoolId: "us-west-2_test", userPoolClientId: "test-client",
    identityPoolId: "us-west-2:test-identity", allowGuestAccess: false,
  } } };
  const config = userPoolServerConfig(original);
  assert.equal(config.Auth?.Cognito.identityPoolId, undefined);
  assert.equal(config.Auth?.Cognito.userPoolId, original.Auth.Cognito.userPoolId);
  assert.equal(config.Auth?.Cognito.userPoolClientId, original.Auth.Cognito.userPoolClientId);
  assert.equal(original.Auth.Cognito.identityPoolId, "us-west-2:test-identity", "Storage config remains intact");
  const storage = { async getItem() { return null; }, async setItem() {}, async removeItem() {}, async clear() {} };
  const credentialsProvider = createAWSCredentialsAndIdentityIdProvider(config.Auth!, storage);
  let tokenReads = 0, networkCalls = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network call"); };
  const accessToken = { payload: { sub: "fixture", exp: 4102444800, "cognito:groups": ["EDITOR"] }, toString: () => "fixture-token" };
  try {
    const session = await runWithAmplifyServerContext(config, { Auth: {
      credentialsProvider,
      tokenProvider: { async getTokens() { tokenReads++; return { accessToken }; } },
    } }, context => fetchAuthSession(context));
    assert.equal(session.tokens?.accessToken, accessToken, "SDK still obtains user tokens");
    assert.equal(session.credentials, undefined, "No unused IAM credentials requested");
    assert.equal(tokenReads, 1);
    const signedOut = await runWithAmplifyServerContext(config, { Auth: {
      credentialsProvider, tokenProvider: { async getTokens() { return null; } },
    } }, context => fetchAuthSession(context));
    assert.equal(signedOut.tokens, undefined);
    assert.equal(signedOut.credentials, undefined);
    await assert.rejects(() => runWithAmplifyServerContext(config, { Auth: {
      credentialsProvider, tokenProvider: { async getTokens() { throw new Error("Token rejected"); } },
    } }, context => fetchAuthSession(context)), /Token rejected/);
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = fetchBefore; }
  console.log("user-pool server config: token checks retained, signed-out/rejected denied, zero identity-pool requests, storage config unchanged");
}
void main().catch(e => { console.error(e); process.exitCode = 1; });

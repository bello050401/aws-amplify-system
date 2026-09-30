import assert from "node:assert/strict";
import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { inspectNextEngineTokens, readNextEngineTokens, saveNextEngineTokens } from "../lib/listing/nextEngine/tokenStore";

const env = { NEXT_ENGINE_TOKEN_SECRET_ID: "arn:aws:secretsmanager:us-west-2:000000000000:secret:bello/next-engine-tokens-staging-z9Y8x7" };
const binding = { credentialVersionId: "version-a", expectedCompanyNeId: "123456" };
const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
let stored = "{}";
const client = { send: async (command: unknown) => {
  if (command instanceof GetSecretValueCommand) {
    assert.equal(command.input.SecretId, env.NEXT_ENGINE_TOKEN_SECRET_ID);
    return { SecretString: stored };
  }
  if (command instanceof PutSecretValueCommand) {
    assert.equal(command.input.SecretId, env.NEXT_ENGINE_TOKEN_SECRET_ID);
    stored = command.input.SecretString ?? "";
    return {};
  }
  throw new Error("unexpected command");
} } as unknown as SecretsManagerClient;

async function main() {
  assert.equal(await readNextEngineTokens(binding, client, env), null);
  assert.equal(await inspectNextEngineTokens(binding, client, env), "EMPTY");
  await saveNextEngineTokens(tokens, binding, client, env);
  assert.deepEqual(JSON.parse(stored), { ...tokens, credentialVersionId: "version-a", companyNeId: "123456" });
  assert.deepEqual(await readNextEngineTokens(binding, client, env), tokens);
  assert.equal(await inspectNextEngineTokens(binding, client, env), "READY");
  assert.equal(await readNextEngineTokens({ ...binding, credentialVersionId: "version-b" }, client, env), null);
  assert.equal(await inspectNextEngineTokens({ ...binding, credentialVersionId: "version-b" }, client, env), "CREDENTIAL_VERSION_MISMATCH");
  assert.equal(await readNextEngineTokens({ ...binding, expectedCompanyNeId: "999999" }, client, env), null);
  assert.equal(await inspectNextEngineTokens({ ...binding, expectedCompanyNeId: "999999" }, client, env), "COMPANY_MISMATCH");
  stored = JSON.stringify(tokens);
  assert.equal(await readNextEngineTokens(binding, client, env), null, "Legacy unbound pair must reconnect");
  stored = "not-json";
  await assert.rejects(readNextEngineTokens(binding, client, env));
  assert.equal(await inspectNextEngineTokens(binding, client, env), "INVALID_FORMAT");
  await assert.rejects(readNextEngineTokens(binding, client, {}));
  assert.equal(await inspectNextEngineTokens(binding, client, {}), "REFERENCE_INVALID");
  await assert.rejects(saveNextEngineTokens(tokens, binding, client, {}));
  await assert.rejects(saveNextEngineTokens(tokens, binding, client, {
    ...env, NEXT_ENGINE_APP_SECRET_ID: env.NEXT_ENGINE_TOKEN_SECRET_ID,
  }), "Token writes cannot target the credentials secret");
  const denied = { send: async () => { throw new Error("synthetic-secret-detail"); } } as unknown as SecretsManagerClient;
  await assert.rejects(readNextEngineTokens(binding, denied, env), error => error instanceof Error && !error.message.includes("synthetic-secret-detail"));
  assert.equal(await inspectNextEngineTokens(binding, denied, env), "READ_ERROR");
  await assert.rejects(saveNextEngineTokens(tokens, binding, denied, env), error => error instanceof Error && !error.message.includes("synthetic-secret-detail"));
  console.log("Next Engine token store: bound pair, legacy rejection and redacted failures passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

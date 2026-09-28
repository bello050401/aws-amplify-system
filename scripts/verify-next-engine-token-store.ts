import assert from "node:assert/strict";
import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readNextEngineTokens, saveNextEngineTokens } from "../lib/listing/nextEngine/tokenStore";

const env = { NEXT_ENGINE_TOKEN_SECRET_ID: "synthetic/preprovisioned" };
const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
let saved: unknown = null;
const client = { send: async (command: unknown) => {
  if (command instanceof GetSecretValueCommand) {
    assert.equal(command.input.SecretId, env.NEXT_ENGINE_TOKEN_SECRET_ID);
    return { SecretString: JSON.stringify(tokens) };
  }
  if (command instanceof PutSecretValueCommand) {
    assert.equal(command.input.SecretId, env.NEXT_ENGINE_TOKEN_SECRET_ID);
    saved = JSON.parse(command.input.SecretString ?? "null");
    return {};
  }
  throw new Error("unexpected command");
} } as unknown as SecretsManagerClient;

async function main() {
  assert.deepEqual(await readNextEngineTokens(client, env), tokens);
  await saveNextEngineTokens(tokens, client, env);
  assert.deepEqual(saved, tokens);
  await assert.rejects(readNextEngineTokens(client, {}), error => error instanceof Error && !error.message.includes("synthetic"));
  await assert.rejects(saveNextEngineTokens(tokens, client, {}), error => error instanceof Error && !error.message.includes("synthetic"));
  const malformed = { send: async () => ({ SecretString: JSON.stringify({ accessToken: "synthetic-access" }) }) } as unknown as SecretsManagerClient;
  await assert.rejects(readNextEngineTokens(malformed, env));
  const failed = { send: async () => { throw new Error("synthetic-secret-detail"); } } as unknown as SecretsManagerClient;
  await assert.rejects(readNextEngineTokens(failed, env), error => error instanceof Error && !error.message.includes("synthetic-secret-detail"));
  await assert.rejects(saveNextEngineTokens(tokens, failed, env), error => error instanceof Error && !error.message.includes("synthetic-secret-detail"));
  console.log("Next Engine token store: scoped secret read/write, complete pair and redacted failures passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

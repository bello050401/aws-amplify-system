import assert from "node:assert/strict";
import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { exchangeNextEngineLaunch } from "../lib/listing/nextEngine/authExchange";
import { completeNextEngineLaunch } from "../lib/listing/nextEngine/completeLaunch";
import { readNextEngineTokens, saveNextEngineTokens } from "../lib/listing/nextEngine/tokenStore";

const config = { clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456", credentialVersionId: "version-a" };
const input = { ...config, uid: "synthetic-uid", state: "synthetic-state" };
const env = { NEXT_ENGINE_TOKEN_SECRET_ID: "arn:aws:secretsmanager:us-west-2:000000000000:secret:bello/next-engine-tokens-staging-z9Y8x7" };
let stored = "{}";
let reads = 0;
let writes = 0;
let exchanges = 0;
const secretClient = { send: async (command: unknown) => {
  if (command instanceof GetSecretValueCommand) { reads++; return { SecretString: stored }; }
  if (command instanceof PutSecretValueCommand) { writes++; stored = command.input.SecretString ?? ""; return {}; }
  throw new Error("unexpected AWS call");
} } as unknown as SecretsManagerClient;
const fakeFetch: typeof fetch = async (_url, init) => {
  exchanges++;
  const body = init?.body as URLSearchParams;
  assert.equal(body.get("uid"), input.uid);
  assert.equal(body.get("state"), input.state);
  return new Response(JSON.stringify({ result: "success", uid: input.uid, company_ne_id: "123456",
    access_token: "synthetic-access", refresh_token: "synthetic-refresh" }), { status: 200 });
};

async function main() {
  await completeNextEngineLaunch(input, {
    preflight: () => readNextEngineTokens(config, secretClient, env),
    exchange: value => exchangeNextEngineLaunch(value, fakeFetch),
    verifyConfiguration: async () => config,
    save: tokens => saveNextEngineTokens(tokens, config, secretClient, env),
    readBack: () => readNextEngineTokens(config, secretClient, env),
  });
  assert.equal(exchanges, 1);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["accessToken", "companyNeId", "credentialVersionId", "refreshToken"]);
  assert.deepEqual(await readNextEngineTokens(config, secretClient, env), {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
  });
  console.log("Next Engine real exchange to storage: one exchange, one four-field write and matching read-back passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

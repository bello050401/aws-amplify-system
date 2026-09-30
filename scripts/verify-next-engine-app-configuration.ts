import assert from "node:assert/strict";
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getNextEngineAppConfiguration } from "../lib/listing/nextEngine/appConfiguration";

const env = { NEXT_ENGINE_APP_SECRET_ID: "arn:aws:secretsmanager:us-west-2:000000000000:secret:bello/next-engine-app-staging-a1B2c3" };
const valid = { clientId: "synthetic-id", clientSecret: "synthetic-secret", companyNeId: "123456" };
const client = (value: unknown, versionId = "version-a") => ({
  send: async (command: unknown) => {
    assert(command instanceof GetSecretValueCommand);
    assert.equal(command.input.SecretId, env.NEXT_ENGINE_APP_SECRET_ID);
    return { SecretString: JSON.stringify(value), VersionId: versionId };
  },
}) as unknown as SecretsManagerClient;

async function main() {
  assert.equal(await getNextEngineAppConfiguration(client(valid), {}), null);
  assert.deepEqual(await getNextEngineAppConfiguration(client(valid), env), {
    clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456", credentialVersionId: "version-a",
  });
  await assert.rejects(getNextEngineAppConfiguration(client(valid), {
    ...env, NEXT_ENGINE_TOKEN_SECRET_ID: env.NEXT_ENGINE_APP_SECRET_ID,
  }), "App credentials and tokens must be separate secrets");
  for (const value of [
    { ...valid, companyNeId: "BELLO" }, { ...valid, clientId: "bad id" },
    { ...valid, clientSecret: "bad secret" }, { ...valid, extra: "unexpected" },
    { clientId: "synthetic-id" },
  ]) await assert.rejects(getNextEngineAppConfiguration(client(value), env), error =>
    error instanceof Error && !error.message.includes("synthetic-secret"));
  await assert.rejects(getNextEngineAppConfiguration(client(valid, ""), env));
  const denied = { send: async () => { throw new Error("synthetic-secret-detail"); } } as unknown as SecretsManagerClient;
  await assert.rejects(getNextEngineAppConfiguration(denied, env), error =>
    error instanceof Error && !error.message.includes("synthetic-secret-detail"));
  console.log("Next Engine app configuration: strict secret, version binding and redacted failures passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

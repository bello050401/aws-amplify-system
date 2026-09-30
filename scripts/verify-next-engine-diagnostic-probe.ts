import assert from "node:assert/strict";
import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { NEXT_ENGINE_DIAGNOSTIC_STAGE, runNextEngineDiagnosticProbe } from "../lib/listing/nextEngine/diagnosticProbe";

const appArn = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-app-credentials-staging-a1B2c3";
const tokenArn = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-z9Y8x7";
const env = { NEXT_ENGINE_APP_SECRET_ID: appArn, NEXT_ENGINE_TOKEN_SECRET_ID: tokenArn };
const syntheticApp = { clientId: "bello-diagnostic-only", clientSecret: "bello-diagnostic-only", companyNeId: "0" };
let appValue: unknown = syntheticApp;
let tokenCurrent = "{}";
let staged: string | null = null;
let writes = 0;
let denyPut = false;
const client = { send: async (command: unknown) => {
  if (command instanceof GetSecretValueCommand) {
    if (command.input.SecretId === appArn) return { SecretString: JSON.stringify(appValue), VersionId: "synthetic-version-a" };
    assert.equal(command.input.SecretId, tokenArn);
    if (command.input.VersionStage === "AWSCURRENT") return { SecretString: tokenCurrent };
    assert.equal(command.input.VersionStage, NEXT_ENGINE_DIAGNOSTIC_STAGE);
    if (staged === null) { const error = new Error("missing stage"); error.name = "ResourceNotFoundException"; throw error; }
    return { SecretString: staged };
  }
  if (command instanceof PutSecretValueCommand) {
    assert.equal(command.input.SecretId, tokenArn);
    assert.deepEqual(command.input.VersionStages, [NEXT_ENGINE_DIAGNOSTIC_STAGE]);
    assert(!command.input.VersionStages?.includes("AWSCURRENT"));
    if (denyPut) throw new Error("denied synthetic detail");
    writes++;
    staged = command.input.SecretString ?? null;
    return { VersionId: command.input.ClientRequestToken };
  }
  throw new Error("unexpected command");
} } as unknown as SecretsManagerClient;

async function main() {
  assert.equal(await runNextEngineDiagnosticProbe(client, env), true);
  assert.equal(writes, 1);
  assert.equal(tokenCurrent, "{}", "AWSCURRENT must remain untouched");
  assert.deepEqual(Object.keys(JSON.parse(staged!)).sort(), ["accessToken", "companyNeId", "credentialVersionId", "refreshToken"]);
  assert.equal(await runNextEngineDiagnosticProbe(client, env), false, "A second run cannot relabel an existing stage");
  assert.equal(writes, 1);

  staged = null;
  appValue = { ...syntheticApp, clientId: "real-user-app" };
  assert.equal(await runNextEngineDiagnosticProbe(client, env), false);
  assert.equal(writes, 1, "Real credentials must not trigger a write");
  appValue = syntheticApp;
  tokenCurrent = JSON.stringify({ accessToken: "real-token", refreshToken: "real-refresh" });
  assert.equal(await runNextEngineDiagnosticProbe(client, env), false);
  assert.equal(writes, 1, "Existing current token must not be overwritten");
  tokenCurrent = "{}";
  denyPut = true;
  assert.equal(await runNextEngineDiagnosticProbe(client, env), false);
  assert.equal(await runNextEngineDiagnosticProbe(client, { ...env, NEXT_ENGINE_TOKEN_SECRET_ID: appArn }), false);
  console.log("Next Engine diagnostic probe: synthetic staging version, current-token protection and fail-closed writes passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

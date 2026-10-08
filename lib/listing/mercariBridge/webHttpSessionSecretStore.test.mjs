import test from "node:test";
import assert from "node:assert/strict";
import { GetSecretValueCommand, PutSecretValueCommand } from
  "@aws-sdk/client-secrets-manager";
import { SecretsManagerWebHttpSessionStore } from
  "./webHttpSessionSecretStore.ts";

const arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:bello/mercari-web-session-ABC123";
const record = { schemaVersion: 1, shopId: "shop", ownerSub: "owner",
  sessionId: "fef2b7ee-cf21-429f-99bf-9439eafab3af",
  authenticatedAt: "2026-10-09T00:00:00.000Z",
  expiresAt: null, opaqueMaterial: "sensitive" };

test("adapter uses only an existing dedicated secret and does not expose values", async () => {
  const commands = [];
  const client = { send: async command => {
    commands.push(command);
    return command instanceof GetSecretValueCommand ?
      { SecretString: JSON.stringify(record) } : {};
  } };
  const store = new SecretsManagerWebHttpSessionStore(client, arn);
  await store.write(record);
  const saved = await store.read();
  assert.deepEqual(saved, record);
  assert.equal(commands.length, 2);
  assert.ok(commands[0] instanceof PutSecretValueCommand);
  assert.ok(commands[1] instanceof GetSecretValueCommand);
  assert.equal(commands[0].input.SecretId, arn);
  assert.equal(commands[0].input.ClientRequestToken, record.sessionId);
  assert.equal(commands[1].input.VersionStage, "AWSCURRENT");
  assert.throws(() => new SecretsManagerWebHttpSessionStore(client,
    "bello/mercari-access-token"));
});

import assert from "node:assert/strict";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { EconveniCredentialStore, ECONVENI_SECRET_ID, validateEconveniCredentials } from "../lib/listing/econveni/credentials";
import Module from "node:module";

async function main() {
  let value = JSON.stringify({ schemaVersion: 1, configured: false });
  let fail = false;
  const commands: any[] = [];
  const fake = { send: async (command: any) => {
    commands.push(command);
    if (fail) throw new Error("sensitive-password-or-response-body");
    if (command instanceof GetSecretValueCommand) return { SecretString: value };
    assert.ok(command instanceof PutSecretValueCommand);
    value = command.input.SecretString!;
    return {};
  } };
  const store = new EconveniCredentialStore(fake);
  assert.deepEqual(await store.state(), { configured: false, updatedAt: null });
  for (const input of [null, {}, { loginId: "id", password: "" }, { loginId: "id", password: "a\nb" }, { loginId: "id", password: "a".repeat(1025) }]) {
    assert.throws(() => validateEconveniCredentials(input));
  }
  const saved = await store.save({ loginId: " example ", password: " secret-keeps-spaces " }, "admin-sub");
  assert.equal(saved.configured, true);
  assert.equal((await store.credentials())?.password, " secret-keeps-spaces ");
  assert.equal((await store.credentials())?.loginId, "example");
  assert.equal(JSON.parse(value).updatedBy, "admin-sub");
  assert.deepEqual(Object.keys(await store.state()).sort(), ["configured", "updatedAt"]);
  assert.ok(commands.every(c => c.input.SecretId === ECONVENI_SECRET_ID));
  fail = true;
  await assert.rejects(store.state(), error => !String(error).includes("sensitive-password"));
  await assert.rejects(store.save({ loginId: "id", password: "pwd" }, "admin"), error => !String(error).includes("sensitive-password"));
  fail = false;
  value = "{}";
  await assert.rejects(store.state());
  value = JSON.stringify({ schemaVersion: 1, configured: false });

  // Exercise the real server actions with role and AWS boundaries mocked.
  let role: string | null = null;
  let sub: string | null = "admin-sub";
  const moduleApi = Module as any;
  const originalLoad = moduleApi._load;
  moduleApi._load = function(request: string, ...args: any[]) {
    if (request.includes("requireInventoryUser")) return {
      getInventoryRole: async () => role,
      getCurrentInventoryUserSub: async () => sub,
    };
    return originalLoad.call(this, request, ...args);
  };
  const originalSend = SecretsManagerClient.prototype.send;
  (SecretsManagerClient.prototype as any).send = fake.send;
  try {
    const { getEconveniSettingsAction, saveEconveniSettingsAction } = require("../app/actions/econveniSettings");
    for (role of [null, "EDITOR", "VIEWER"]) {
      const before = commands.length;
      assert.equal((await getEconveniSettingsAction()).ok, false);
      assert.equal((await saveEconveniSettingsAction({ loginId: "id", password: "pwd" })).ok, false);
      assert.equal(commands.length, before, "Denied roles must never touch credentials");
    }
    role = "ADMIN"; sub = null;
    assert.equal((await saveEconveniSettingsAction({ loginId: "id", password: "pwd" })).ok, false);
    sub = "admin-sub";
    const result = await saveEconveniSettingsAction({ loginId: "id", password: "server-secret" });
    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes("server-secret"));
    const read = await getEconveniSettingsAction();
    assert.equal(read.ok, true);
    assert.ok(!JSON.stringify(read).includes("server-secret"));
    fail = true;
    assert.ok(!JSON.stringify(await getEconveniSettingsAction()).includes("sensitive-password"));
  } finally {
    moduleApi._load = originalLoad;
    SecretsManagerClient.prototype.send = originalSend;
  }
  console.log("PASS: validation, exact secret scope, opaque password, safe state/errors, ADMIN-only read/write, missing identity denial");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

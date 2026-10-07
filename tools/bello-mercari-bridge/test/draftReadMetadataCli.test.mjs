import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDraftReadMetadataCli } from "../src/draftReadMetadataCli.mjs";

process.env.LOCALAPPDATA ??= join(tmpdir(), "bello-test-localappdata");
const dataDir = join(process.env.LOCALAPPDATA, "BELLO", "MercariBridge");
const configPath = join(dataDir, "config.json");
const shopId = "evkhihBFFNn5hukMS9s36H";
const config = { origin:
  "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com",
  dataDir, createTestObservationEnabled: false };

test("requires explicit one-shot flag and derives account only from local binding", async () => {
  let readCount = 0;
  const read = async path => {
    readCount++;
    return JSON.stringify(path === configPath ? config :
      { schemaVersion: 1, accountReference: shopId });
  };
  let probed = null;
  const probe = async value => {
    probed = value;
    return { status: "NO_QUERY_METADATA", observations: [],
      closeStatus: "CLOSED", allowFinalCreate: false };
  };
  const blocked = await runDraftReadMetadataCli(["--config", configPath],
    { read, probe });
  assert.equal(blocked.status, "OPT_IN_REQUIRED");
  assert.equal(readCount, 0);
  const result = await runDraftReadMetadataCli(["--config", configPath,
    "--confirm-readonly-draft-metadata"], { read, probe });
  assert.equal(result.status, "NO_QUERY_METADATA");
  assert.equal(probed.shopId, shopId);
  assert.equal(probed.confirmReadOnly, true);
  assert.equal(probed.expectedRowCount, 12);
  assert.equal(probed.rowIndex, 0);
  assert.equal(JSON.stringify(result).includes(shopId), false);
});

test("wrong account binding or test mode never opens the browser", async () => {
  let called = false;
  const probe = async () => { called = true; };
  const args = ["--config", configPath, "--confirm-readonly-draft-metadata"];
  const wrong = await runDraftReadMetadataCli(args, { read: async path =>
    JSON.stringify(path === configPath ? config :
      { schemaVersion: 1, accountReference: [shopId] }), probe });
  assert.equal(wrong.status, "ACCOUNT_UNVERIFIED");
  const testMode = await runDraftReadMetadataCli(args, { read: async path =>
    JSON.stringify(path === configPath ?
      { ...config, createTestObservationEnabled: true } :
      { schemaVersion: 1, accountReference: shopId }), probe });
  assert.equal(testMode.status, "CONFIG_UNVERIFIED");
  assert.equal(called, false);
});

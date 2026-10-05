import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const sku = "B005757-TEST-20261004-caf445ac6e676343";
const run = (...args) => execFileSync(process.execPath, [cli, ...args],
  { encoding: "utf8" });

test("manual GPT-tab CLI claims once and exports only unverified records", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-create-cli-"));
  const claimPath = join(root, "claim-export.json");
  const resultPath = join(root, "result-export.json");
  try {
    assert.equal(JSON.parse(run("preflight-private-create", "--root", root))
      .preflight.clear, true);
    assert.throws(() => run("claim-private-create-once", "--root", root,
      "--confirm-sku", "WRONG"));
    const claim = JSON.parse(run("claim-private-create-once", "--root", root,
      "--confirm-sku", sku));
    assert.equal(claim.listingConfirmed, false);
    assert.throws(() => run("claim-private-create-once", "--root", root,
      "--confirm-sku", sku));
    run("export-private-create-claim", "--root", root, "--out", claimPath);
    assert.equal(JSON.parse(await readFile(claimPath, "utf8")).attemptId,
      claim.attemptId);
    assert.throws(() => run("record-private-create-ui-unverified", "--root", root,
      "--attempt", claim.attemptId, "--confirm-click", "no"));
    const result = JSON.parse(run("record-private-create-ui-unverified", "--root", root,
      "--attempt", claim.attemptId, "--confirm-click", "yes"));
    assert.deepEqual(result, { outcome: "UNVERIFIED", newRemoteId: null,
      listingConfirmed: false, reason: "NETWORK_NOT_OBSERVED" });
    run("export-private-create-ui-result", "--root", root, "--out", resultPath);
    const exported = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(exported.reasonCode, "NETWORK_NOT_OBSERVED");
    assert.equal(exported.listingConfirmed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

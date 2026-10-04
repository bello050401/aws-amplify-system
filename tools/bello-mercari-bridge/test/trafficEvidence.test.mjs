import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { latestReadTrafficEvidence, saveReadTrafficEvidence } from "../src/trafficEvidence.mjs";

const requestId = "a".repeat(64);
const jobId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

test("old memory-only traffic is an explicit gap, never an HTTP permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-traffic-evidence-"));
  try {
    assert.deepEqual(await latestReadTrafficEvidence(root, requestId), {
      status: "LEGACY_NOT_PERSISTED", entries: [], observedAt: null, directHttpAllowed: false,
    });
    assert.equal((await saveReadTrafficEvidence(root, requestId, jobId, null)).status, "NOT_CAPTURED");
    const latest = await latestReadTrafficEvidence(root, requestId);
    assert.equal(latest.status, "NOT_CAPTURED");
    assert.deepEqual(latest.entries, []);
    assert.match(latest.observedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(latest.directHttpAllowed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only fixed traffic vocabulary is persisted; raw values and extras disappear", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-traffic-evidence-"));
  try {
    const evidence = await saveReadTrafficEvidence(root, requestId, jobId, [
      { host: "mercari-shops.com", method: "POST", type: "fetch", path: "/graphql",
        status: 200, count: 1, cookie: "private-cookie", url: "https://secret.example" },
      { host: "mercari-shops.com", method: "POST", type: "fetch", path: "/secret-path",
        status: 200, count: 1 },
    ]);
    assert.equal(evidence.status, "OBSERVED");
    assert.equal(evidence.directHttpAllowed, false);
    assert.deepEqual(evidence.entries, [{ host: "mercari-shops.com", method: "POST",
      type: "fetch", path: "/graphql", status: 200, count: 1 }]);
    const dir = join(root, "shops-traffic-evidence", requestId);
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    const bytes = await readFile(join(dir, names[0]), "utf8");
    assert.equal(bytes.includes("private-cookie"), false);
    assert.equal(bytes.includes("secret.example"), false);
    assert.equal(bytes.includes("secret-path"), false);
    assert.deepEqual(await latestReadTrafficEvidence(root, requestId), evidence);
    assert.equal((await saveReadTrafficEvidence(root, requestId, jobId, [])).status, "EMPTY");
    assert.equal((await readdir(dir)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

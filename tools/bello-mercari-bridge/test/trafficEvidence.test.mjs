import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      status: "LEGACY_NOT_PERSISTED", entries: [], readQueries: [],
      observedAt: null, directHttpAllowed: false,
    });
    assert.equal((await saveReadTrafficEvidence(root, requestId, jobId, null)).status, "NOT_CAPTURED");
    const latest = await latestReadTrafficEvidence(root, requestId);
    assert.equal(latest.status, "NOT_CAPTURED");
    assert.deepEqual(latest.entries, []);
    assert.deepEqual(latest.readQueries, []);
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
    assert.deepEqual(evidence.readQueries, []);
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

test("read-query evidence persists comparisons and types without values", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-traffic-evidence-"));
  try {
    const candidate = { method: "POST", host: "mercari-shops.com", path: "/graphql",
      operationType: "query", operationName: "ProductEditQuery", querySha256: "b".repeat(64),
      variableFields: [{ field: "productId", type: "string", value: "do-not-store" }],
      variableShapeComplete: true, requestProductMatch: "MATCH", requestShopMatch: "MATCH",
      responseProductMatch: "MATCH", responseShopMatch: "MATCH", graphqlErrors: "NONE",
      httpStatus: 200, authPresenceObserved: true,
      authPresence: { authorization: true, cookie: true, csrf: false,
        secret: "do-not-store" }, rawBody: "do-not-store" };
    const evidence = await saveReadTrafficEvidence(root, requestId, jobId, [], [candidate]);
    assert.equal(evidence.status, "OBSERVED");
    assert.equal(evidence.readQueries.length, 1);
    assert.equal(evidence.directHttpAllowed, false);
    const dir = join(root, "shops-traffic-evidence", requestId);
    const file = (await readdir(dir))[0];
    const bytes = await readFile(join(dir, file), "utf8");
    assert.equal(bytes.includes("do-not-store"), false);
    assert.deepEqual(await latestReadTrafficEvidence(root, requestId), evidence);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema 1 traffic records remain readable with no query candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-traffic-evidence-"));
  try {
    const dir = join(root, "shops-traffic-evidence", requestId);
    await mkdir(dir, { recursive: true });
    const observedAt = "2026-10-04T00:00:00.000Z";
    const entries = [{ host: "mercari-shops.com", method: "POST", type: "fetch",
      path: "/graphql", status: 200, count: 1 }];
    await writeFile(join(dir, "1728000000000-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json"),
      JSON.stringify({ schemaVersion: 1, requestId, jobId, status: "OBSERVED",
        observedAt, entries }));
    assert.deepEqual(await latestReadTrafficEvidence(root, requestId), {
      status: "OBSERVED", entries, readQueries: [], observedAt, directHttpAllowed: false,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

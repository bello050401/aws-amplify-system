import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PINNED_READ_QUERY_SHA256 } from "../src/directReadProbe.mjs";
import { exportSavedDirectReadProof } from "../src/exportDirectReadProof.mjs";
import { saveReadTrafficEvidence } from "../src/trafficEvidence.mjs";

const requestId = "a".repeat(64);
const attemptId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const target = { shopId: "shop-one", remoteId: "2JXePE4ke8UCBTj6mxc4cf",
  inventoryCode: "B005795" };

test("exporter writes only a bounded receipt after saved evidence passes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-proof-export-"));
  const root = join(dataDir, "Queue");
  const configPath = join(dataDir, "config.json");
  const outputPath = join(dataDir, "proof.json");
  try {
    await writeFile(configPath, JSON.stringify({ dataDir, requestId,
      manualObservation: target }));
    await assert.rejects(exportSavedDirectReadProof({ configPath, outputPath }));
    await saveReadTrafficEvidence(root, requestId, attemptId, [], [{
      method: "POST", host: "mercari-shops.com", path: "/graphql",
      operationType: "query", operationName: "EditProductPage",
      querySha256: PINNED_READ_QUERY_SHA256,
      variableFields: [{ field: "id", type: "string" }], variableShapeComplete: true,
      requestProductMatch: "MATCH", requestShopMatch: "UNOBSERVED",
      responseProductMatch: "MATCH", responseShopMatch: "MATCH",
      graphqlErrors: "NONE", httpStatus: 200, authPresenceObserved: true,
      authPresence: { authorization: false, cookie: true, csrf: false },
    }]);
    const proofDir = join(root, "direct-read-probe-once");
    await mkdir(proofDir);
    const key = createHash("sha256").update(`${target.shopId}:${target.remoteId}`).digest("hex");
    await writeFile(join(proofDir, `${key}.json`), JSON.stringify({ schemaVersion: 1,
      operation: "EXACT_READ_HTTP_PROBE_ONCE", attemptId,
      querySha256: PINNED_READ_QUERY_SHA256,
      claimedAt: "2026-10-04T11:36:28.164Z" }));
    await writeFile(join(proofDir, `${key}.result.json`), JSON.stringify({ schemaVersion: 1,
      attemptId, outcome: "MATCHED", httpStatus: 200,
      recordedAt: "2026-10-04T11:36:30.506Z" }));
    await exportSavedDirectReadProof({ configPath, outputPath });
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      schemaVersion: 1, kind: "BELLO_PINNED_DIRECT_READ_PROOF", requestId,
      attemptId, accountReference: target.shopId, remoteId: target.remoteId,
      inventoryCode: target.inventoryCode, status: "DIRECT_HTTP_READ_CONFIRMED",
      reasonCode: "PINNED_HTTP_200_MATCHED", listingConfirmed: false,
    });
    await assert.rejects(exportSavedDirectReadProof({ configPath, outputPath }),
      error => error.code === "EEXIST");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("B005757 read-only config exports its own saved proof", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-b005757-proof-export-"));
  const root = join(dataDir, "Queue");
  const configPath = join(dataDir, "config.json");
  const outputPath = join(dataDir, "proof.json");
  const requestId = "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
  const directReadTarget = { shopId: "evkhihBFFNn5hukMS9s36H",
    remoteId: "2JXjWPRVBxjZ2K2vgTGNqy", inventoryCode: "B005757" };
  try {
    await writeFile(configPath, JSON.stringify({ dataDir, requestId, directReadTarget }));
    await saveReadTrafficEvidence(root, requestId, attemptId, [], [{
      method: "POST", host: "mercari-shops.com", path: "/graphql",
      operationType: "query", operationName: "EditProductPage",
      querySha256: PINNED_READ_QUERY_SHA256,
      variableFields: [{ field: "id", type: "string" }], variableShapeComplete: true,
      requestProductMatch: "MATCH", requestShopMatch: "UNOBSERVED",
      responseProductMatch: "MATCH", responseShopMatch: "MATCH",
      graphqlErrors: "NONE", httpStatus: 200, authPresenceObserved: true,
      authPresence: { authorization: false, cookie: true, csrf: false },
    }]);
    const proofDir = join(root, "direct-read-probe-once");
    await mkdir(proofDir);
    const key = createHash("sha256").update(`${directReadTarget.shopId}:${directReadTarget.remoteId}`)
      .digest("hex");
    await writeFile(join(proofDir, `${key}.json`), JSON.stringify({ schemaVersion: 1,
      operation: "EXACT_READ_HTTP_PROBE_ONCE", attemptId, requestId,
      querySha256: PINNED_READ_QUERY_SHA256, claimedAt: "2026-10-06T00:00:00.000Z" }));
    await writeFile(join(proofDir, `${key}.result.json`), JSON.stringify({ schemaVersion: 1,
      attemptId, outcome: "MATCHED", httpStatus: 200,
      recordedAt: "2026-10-06T00:00:01.000Z" }));
    await exportSavedDirectReadProof({ configPath, outputPath });
    const exported = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual({ requestId: exported.requestId, remoteId: exported.remoteId,
      inventoryCode: exported.inventoryCode, status: exported.status,
      listingConfirmed: exported.listingConfirmed },
    { requestId, remoteId: directReadTarget.remoteId, inventoryCode: "B005757",
      status: "DIRECT_HTTP_READ_CONFIRMED", listingConfirmed: false });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

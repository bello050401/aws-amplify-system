import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildB005413PrivatePreparation } from "./b005413PrivatePreparation.ts";
import { buildPrivateCreatePreparation } from
  "../../../tools/bello-mercari-bridge/src/privateCreatePreparation.mjs";

const saved = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../../tools/bello-mercari-bridge/test/fixtures/b005413-snapshot.json",
  import.meta.url)), "utf8"));
const { schemaVersion, kind, sourceInventoryCode, sourcePriceYen,
  testManagementCode, testPriceYen, visibility, doNotModifyProductId,
  contentEvidence, ...content } = saved;

test("BELLO's B005413 export matches the exact PC no-send boundary", () => {
  const exported = buildB005413PrivatePreparation(content, "B005413", 30000);
  assert.deepEqual(exported, saved);
  const job = buildPrivateCreatePreparation(exported);
  assert.equal(job.status, "PREPARED_NO_SEND");
  assert.equal(job.snapshotFingerprint,
    "4ad9da7231607cda57b6c55dfac61677ae21abc56dfceb3df90d8408c7d7dc7e");
});

test("a changed BELLO draft cannot export the pinned B005413 test", () => {
  for (const changed of [
    { ...content, description: `${content.description} changed` },
    { ...content, draftUpdatedAt: "2026-10-07T00:00:00.000Z" },
    { ...content, imageRefs: [{ ...content.imageRefs[0], storageKey: "inventory/other.jpg" }] },
    { ...content, shippingMethod: "SAGAWA" },
  ]) assert.equal(buildB005413PrivatePreparation(changed, "B005413", 30000), null);
  assert.equal(buildB005413PrivatePreparation(content, "B005413", 30004), null);
  assert.equal(buildB005413PrivatePreparation(content, "B005659", 30000), null);
});

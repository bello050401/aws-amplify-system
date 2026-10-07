import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readShopListingWindow, reserveShopListingSend } from
  "../src/listingSendGate.mjs";

const SHOP = "evkhihBFFNn5hukMS9s36H";
const inventoryId = "a12f3587-cbbb-4c09-ae78-595b2b3e353f";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

test("a durable per-shop marker forces 30 seconds between possible sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-listing-gap-"));
  try {
    let nowMs = Date.parse("2026-10-07T12:00:00.000Z");
    const now = () => nowMs;
    const first = await reserveShopListingSend(root,
      { shopId: SHOP, inventoryId, operation: "CREATE", attemptId: firstId }, { now });
    assert.equal(first.potentialSendAt, "2026-10-07T12:00:00.000Z");
    nowMs += 5_000;
    assert.deepEqual(await readShopListingWindow(root, SHOP, nowMs),
      { remainingSeconds: 25, nextAllowedAt: "2026-10-07T12:00:30.000Z" });
    let waited = 0;
    const second = await reserveShopListingSend(root,
      { shopId: SHOP, inventoryId, operation: "RELIST", attemptId: secondId },
      { now, sleep: async ms => { waited = ms; nowMs += ms; } });
    assert.equal(waited, 25_000);
    assert.equal(second.potentialSendAt, "2026-10-07T12:00:30.000Z");
    assert.equal((await readdir(join(root, "listing-send-attempts"))).filter(
      name => name.endsWith(".json")).length, 2);
    assert.equal(JSON.parse(await readFile(join(root, "listing-send-attempts",
      `${SHOP}-${secondId}.json`), "utf8")).status, "POTENTIAL_SEND_ONCE");
    await assert.rejects(reserveShopListingSend(root,
      { shopId: SHOP, inventoryId, operation: "RELIST", attemptId: secondId },
      { now, sleep: async ms => { nowMs += ms; } }), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

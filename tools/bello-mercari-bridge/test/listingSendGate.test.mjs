import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readShopListingWindow, withShopListingSend } from
  "../src/listingSendGate.mjs";

const SHOP = "evkhihBFFNn5hukMS9s36H";
const inventoryId = "a12f3587-cbbb-4c09-ae78-595b2b3e353f";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const target = (attemptId, operation = "RELIST") =>
  ({ shopId: SHOP, inventoryId, operation, attemptId });

test("a private CREATE and later RELIST share one 30-second shop gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-listing-legacy-"));
  const dir = join(root, "listing-send-attempts");
  try {
    await mkdir(dir);
    const legacy = join(dir, `${SHOP}.lock`);
    await writeFile(legacy, "");
    let mono = 1000;
    await withShopListingSend(root, target(firstId, "CREATE"), async () => {
      assert.equal((await readShopListingWindow(root, SHOP, mono)).remainingSeconds,
        null, "a concurrent UI must see the active lock");
      await assert.rejects(withShopListingSend(root, target(secondId),
        async () => {}, { monoNow: () => mono }), { code: "EEXIST" });
      mono += 5_000; // The final click and result verification take five seconds.
    }, { monoNow: () => mono });
    assert.equal(await readFile(legacy, "utf8"), "");
    assert.equal((await readShopListingWindow(root, SHOP, mono)).remainingSeconds, 30);
    mono += 5_000;
    assert.equal((await readShopListingWindow(root, SHOP, mono)).remainingSeconds, 25);
    let waited = 0;
    await withShopListingSend(root, target(secondId), async () => {
      assert.equal(mono, 36_000, "the next send starts 30 seconds after settlement");
    }, { monoNow: () => mono, sleep: async ms => { waited += ms; mono += ms; } });
    assert.equal(waited, 25_000);
    assert.equal((await readdir(dir)).filter(name => name.endsWith(".json")).length, 2);
    assert.equal(JSON.parse(await readFile(join(dir, `${SHOP}-${secondId}.json`),
      "utf8")).status, "POTENTIAL_SEND_ONCE");
    assert.equal(JSON.parse(await readFile(join(dir, `${SHOP}-${firstId}.json`),
      "utf8")).operation, "CREATE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a prior marker after restart requires a full monotonic wait despite wall time", async t => {
  const root = await mkdtemp(join(tmpdir(), "bello-listing-restart-"));
  const dir = join(root, "listing-send-attempts");
  try {
    await mkdir(dir);
    await writeFile(join(dir, `${SHOP}-legacy.json`), JSON.stringify({
      schemaVersion: 1, shopId: SHOP, potentialSendAt: "2020-01-01T00:00:00Z",
      minimumGapSeconds: 30, status: "POTENTIAL_SEND_ONCE",
    }));
    let mono = 1000;
    assert.equal((await readShopListingWindow(root, SHOP, mono)).remainingSeconds, 30);
    let wall = Date.parse("2026-10-07T12:00:00Z");
    t.mock.method(Date, "now", () => wall);
    let waited = 0;
    await withShopListingSend(root, target(firstId), async () => {
      assert.equal(mono, 31_000);
    }, { monoNow: () => mono, sleep: async ms => {
      waited += ms; mono += ms; wall += 3_600_000; // Wall time jumps an hour each tick.
    } });
    assert.equal(waited, 30_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an abandoned new gate remains closed for manual review", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-listing-lock-"));
  const dir = join(root, "listing-send-attempts");
  try {
    await mkdir(join(dir, `${SHOP}.listing-gate.lock`), { recursive: true });
    assert.equal((await readShopListingWindow(root, SHOP)).remainingSeconds, null);
    await assert.rejects(withShopListingSend(root, target(firstId), async () => {}),
      { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an uncertain send also starts a full cooldown after its outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-listing-unknown-"));
  try {
    let mono = 1000;
    await assert.rejects(withShopListingSend(root, target(firstId), async () => {
      mono += 2_000;
      throw Error("Shops outcome unknown");
    }, { monoNow: () => mono }), /Shops outcome unknown/);
    assert.equal((await readShopListingWindow(root, SHOP, mono)).remainingSeconds, 30);
    assert.equal((await readdir(join(root, "listing-send-attempts"))).filter(
      name => name.endsWith(".json")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("removing a seen marker never clears an in-process cooldown", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-listing-missing-"));
  const dir = join(root, "listing-send-attempts");
  try {
    await mkdir(dir);
    const marker = join(dir, `${SHOP}-legacy.json`);
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, shopId: SHOP,
      potentialSendAt: "2020-01-01T00:00:00Z", minimumGapSeconds: 30 }));
    assert.equal((await readShopListingWindow(root, SHOP, 1000)).remainingSeconds, 30);
    await rm(marker);
    await assert.rejects(readShopListingWindow(root, SHOP, 2000),
      /marker disappeared/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

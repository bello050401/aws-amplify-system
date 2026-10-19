import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotStore, isInventoryItem, type KeyValueStore } from "../src/domain/snapshot";
import { previewItems } from "../src/preview/fixture";

function memory() {
  const data = new Map<string, string>();
  const storage: KeyValueStore = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => { data.set(key, value); },
    removeItem: async (key) => { data.delete(key); },
  };
  return { data, storage };
}
const time = "2026-10-17T03:00:00.000Z";
test("historical negative stock remains readable without dropping the inventory list", async () => {
  const { storage } = memory();
  const negative = { ...previewItems[0], id: "historical-negative", quantity: -1 };
  const store = new SnapshotStore(storage, "staff", "qa");
  await store.write([...previewItems, negative], time);
  const loaded = await store.read();
  assert.equal(loaded?.items.length, previewItems.length + 1);
  assert.equal(loaded?.items.at(-1)?.quantity, -1);
  for (const quantity of [NaN, Infinity, 1.5]) assert.equal(isInventoryItem({ ...negative, quantity }), false);
});
test("previously loaded records survive restarting the app", async () => {
  const { storage } = memory(); await new SnapshotStore(storage, "staff-A", "production").write(previewItems, time);
  const loaded = await new SnapshotStore(storage, "staff-A", "production").read();
  assert.deepEqual(loaded?.items, previewItems); assert.equal(loaded?.fetchedAt, time);
});
test("snapshot is separated by account and backend environment", async () => {
  const { storage } = memory(); await new SnapshotStore(storage, "staff-A", "production").write(previewItems, time);
  assert.equal(await new SnapshotStore(storage, "staff-B", "production").read(), null);
  assert.equal(await new SnapshotStore(storage, "staff-A", "preview").read(), null);
});
test("corrupt or old-version snapshots are not displayed", async () => {
  const { storage, data } = memory(); const store = new SnapshotStore(storage, "staff", "production");
  await store.write(previewItems, time); const key = [...data.keys()][0];
  for (const invalid of ["not json", JSON.stringify({ schema: 0, owner: "staff", fetchedAt: time, items: previewItems }), JSON.stringify({ schema: 1, owner: "staff", fetchedAt: time, items: [{}] })]) {
    data.set(key, invalid); assert.equal(await store.read(), null);
  }
});
test("logout clears only that account and cannot be repopulated by pending work", async () => {
  const { storage, data } = memory(); const a = new SnapshotStore(storage, "A", "production"); const b = new SnapshotStore(storage, "B", "production");
  await b.write(previewItems, time); const pending = a.write(previewItems, time); const logout = a.clearOnLogout();
  await Promise.all([pending, logout]); await a.write(previewItems, time);
  assert.equal(await a.read(), null); assert.equal(data.size, 1); assert.ok(await b.read());
});
test("cache failure is observable and cannot silently count as persistence", async () => {
  const { storage } = memory(); storage.setItem = async () => { throw new Error("storage full"); };
  await assert.rejects(() => new SnapshotStore(storage, "A", "production").write(previewItems, time));
});
test("snapshot freezes confirmed data at write time and excludes unexpected fields", async () => {
  const { storage, data } = memory(); const store = new SnapshotStore(storage, "A", "production");
  const item = { ...previewItems[0], unexpectedToken: "do-not-cache" };
  const writing = store.write([item], time); item.quantity = 999; await writing;
  assert.equal((await store.read())?.items[0].quantity, 11);
  assert.equal([...data.values()][0].includes("do-not-cache"), false);
});

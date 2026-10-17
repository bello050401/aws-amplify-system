import assert from "node:assert/strict";
import { test } from "node:test";
import { InventoryEditor, InventoryWriteError, OFFLINE_WARNING, type EditorPorts, type SaveRequest } from "../src/domain/editor";
import { previewItems } from "../src/preview/fixture";

function fixture() {
  let online = true;
  const calls: SaveRequest[] = [];
  const base = { ...previewItems[0] };
  const ports: EditorPorts = {
    online: async () => online,
    newMutationId: () => `request-${calls.length + 1}`,
    save: async (request) => {
      calls.push(request);
      return { ...base, ...request.draft, quantity: Number(request.draft.quantity),
        plannedSalePrice: request.draft.plannedSalePrice === "" ? null : Number(request.draft.plannedSalePrice),
        updatedAt: "2026-10-17T02:00:00.000Z" };
    },
  };
  const editor = new InventoryEditor(base, ports);
  return { editor, ports, base, calls, setOnline: (value: boolean) => { online = value; } };
}

test("offline save warns without sending, retaining draft and original inventory", async () => {
  const f = fixture(); f.editor.change("quantity", "14"); f.setOnline(false);
  assert.equal(await f.editor.save(), null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.editor.getSnapshot().warning, OFFLINE_WARNING);
  assert.equal(f.editor.getSnapshot().draft.quantity, "14");
  assert.equal(f.editor.getSnapshot().saved.quantity, 11);
  assert.equal(f.editor.getSnapshot().dirty, true);
});
test("only leaving dirty editor opens confirmation; editing itself does not", () => {
  const f = fixture(); f.editor.change("note", "保持したい内容");
  assert.equal(f.editor.getSnapshot().leaveConfirmation, false);
  assert.equal(f.editor.requestLeave(), false);
  assert.equal(f.editor.getSnapshot().leaveConfirmation, true);
  f.editor.continueEditing();
  assert.equal(f.editor.getSnapshot().leaveConfirmation, false);
  assert.equal(f.editor.getSnapshot().draft.note, "保持したい内容");
});
test("save from leave dialog stays there while offline and retains all fields", async () => {
  const f = fixture(); f.editor.change("name", "変更した名前"); f.editor.change("note", "備考");
  f.editor.requestLeave(); f.setOnline(false); await f.editor.save();
  assert.equal(f.editor.getSnapshot().leaveConfirmation, true);
  assert.equal(f.editor.getSnapshot().draft.name, "変更した名前");
  assert.equal(f.editor.getSnapshot().draft.note, "備考");
});
test("reconnection does not trigger a write; explicit retry succeeds", async () => {
  const f = fixture(); f.setOnline(false); f.editor.change("quantity", "14"); await f.editor.save();
  f.setOnline(true); await Promise.resolve();
  assert.equal(f.calls.length, 0);
  assert.equal(f.editor.getSnapshot().saved.quantity, 11);
  const saved = await f.editor.save();
  assert.equal(saved?.quantity, 14); assert.equal(f.calls.length, 1);
  assert.equal(f.editor.getSnapshot().dirty, false);
  assert.equal(f.editor.getSnapshot().warning, null);
});
test("discard is local only and restores original without writes", () => {
  const f = fixture(); f.editor.change("quantity", "99"); f.editor.requestLeave();
  assert.equal(f.editor.discard(), true);
  assert.equal(f.editor.getSnapshot().draft.quantity, "11");
  assert.equal(f.editor.getSnapshot().dirty, false);
  assert.equal(f.calls.length, 0);
});
test("unchanged and reverted fields leave without confirmation or writes", async () => {
  const f = fixture(); assert.equal(f.editor.requestLeave(), true);
  f.editor.change("quantity", "9"); f.editor.change("quantity", "11");
  assert.equal(f.editor.requestLeave(), true); await f.editor.save();
  assert.equal(f.calls.length, 0);
});
test("duplicate taps cannot send concurrent saves or discard the in-flight edit", async () => {
  const f = fixture(); let release!: () => void;
  f.ports.online = () => new Promise<boolean>((resolve) => { release = () => resolve(true); });
  f.editor.change("quantity", "5"); const first = f.editor.save();
  assert.equal(await f.editor.save(), null); assert.equal(f.editor.discard(), false);
  assert.equal(f.editor.requestLeave(), false);
  f.editor.change("quantity", "40"); assert.equal(f.editor.getSnapshot().draft.quantity, "5");
  release(); await first; assert.equal(f.calls.length, 1);
});
for (const failure of ["offline", "unauthorized", "forbidden", "conflict", "server"] as const) {
  test(`${failure} response retains edits and does not update displayed inventory`, async () => {
    const f = fixture(); f.ports.save = async () => { throw new InventoryWriteError(failure); };
    f.editor.change("quantity", "42"); assert.equal(await f.editor.save(), null);
    assert.equal(f.editor.getSnapshot().draft.quantity, "42");
    assert.equal(f.editor.getSnapshot().saved.quantity, 11);
    assert.equal(f.editor.getSnapshot().dirty, true);
    if (failure !== "offline") assert.notEqual(f.editor.getSnapshot().warning, OFFLINE_WARNING);
  });
}
test("lost acknowledgement retries identical mutation ID and body, without reporting offline", async () => {
  const f = fixture(); const seen: SaveRequest[] = []; const successfulSave = f.ports.save;
  f.ports.save = async (request) => { seen.push(request); if (seen.length === 1) throw new Error("connection lost after write"); return successfulSave(request); };
  f.editor.change("quantity", "13"); await f.editor.save();
  assert.equal(f.editor.getSnapshot().outcomeUncertain, true);
  assert.notEqual(f.editor.getSnapshot().warning, OFFLINE_WARNING);
  f.editor.change("quantity", "2"); assert.equal(f.editor.getSnapshot().draft.quantity, "13");
  await f.editor.save(); assert.deepEqual(seen[0], seen[1]);
  assert.equal(f.editor.getSnapshot().outcomeUncertain, false);
});
test("invalid numeric fields never reach the server", async () => {
  for (const quantity of ["-1", "1.1", "abc", "9007199254740992"]) {
    const f = fixture(); f.editor.change("quantity", quantity); await f.editor.save(); assert.equal(f.calls.length, 0);
  }
});
test("server returning a different item is not treated as saved", async () => {
  const f = fixture(); f.ports.save = async () => ({ ...f.base, id: "other-item" });
  f.editor.change("quantity", "2"); assert.equal(await f.editor.save(), null);
  assert.equal(f.editor.getSnapshot().saved.id, f.base.id); assert.equal(f.editor.getSnapshot().dirty, true);
});

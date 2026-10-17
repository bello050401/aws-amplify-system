import assert from "node:assert/strict";
import test from "node:test";
import { InventoryEditor } from "../src/domain/editor";
import { draftFor, mergeInventoryRead, mergeInventoryThumbnails, sameDraft, validateDraft } from "../src/domain/inventory";
import { DETAIL_FIELDS, copyDetailValues, visibleDetailFields } from "../src/domain/detailFields";
import { previewItems } from "../src/preview/fixture";

test("all screenshot detail fields are distinct and numeric-looking codes/measurements retain text", () => {
  assert.equal(DETAIL_FIELDS.length, 35);
  assert.equal(new Set(DETAIL_FIELDS.map(field => field.key)).size, 35);
  const draft = draftFor(previewItems[0]);
  assert.equal(draft.quantity, "11"); assert.equal(draft.details.purchaseQuantity, "3");
  assert.equal(draft.plannedSalePrice, "29800"); assert.equal(draft.details.purchasePrice, "5940");
  draft.details.depth = "54.5"; draft.details.seatDimensions = "幅46 奥行40 高さ45";
  draft.details.externalProductId = "0000123";
  assert.equal(validateDraft(draft), null);
});
test("state choices retain the existing BELLO master ID through offline editing and save", async () => {
  const item = previewItems[0];
  let online = false;
  let capturedId: string | undefined;
  const editor = new InventoryEditor(item, { online: async () => online, newMutationId: () => "state-edit", save: async request => {
    capturedId = request.draft.statusId;
    return { ...item, statusId: request.draft.statusId, condition: request.draft.condition };
  } });
  editor.chooseStatus("unknown-id"); assert.equal(editor.getSnapshot().dirty, false);
  editor.chooseStatus("preview-status-worn");
  assert.equal(editor.getSnapshot().draft.statusId, "preview-status-worn");
  assert.equal(editor.getSnapshot().draft.condition, "やや傷や汚れあり");
  assert.equal(editor.getSnapshot().draft.details.conditionRating, "3.5");
  await editor.save(); assert.equal(capturedId, undefined);
  assert.equal(editor.getSnapshot().warning, "【圏外です】");
  online = true; await editor.save(); assert.equal(capturedId, "preview-status-worn");
  editor.chooseStatus(""); assert.equal(editor.getSnapshot().draft.statusId, "");
  editor.discard(); assert.equal(editor.getSnapshot().draft.statusId, "preview-status-worn");
});
test("nested edits are dirty, retained offline, explicitly saved, and discarded independently", async () => {
  let online = false, writes = 0;
  const base = { ...previewItems[0], details: { ...previewItems[0].details } };
  const editor = new InventoryEditor(base, {
    online: async () => online, newMutationId: () => "test-detail-edit",
    save: async request => { writes++; return { ...base, details: { ...request.draft.details }, updatedAt: "2026-10-17T03:00:00Z" }; },
  });
  editor.changeDetail("depth", "55.5"); editor.changeDetail("adminMemo", "保持するメモ");
  assert.equal(editor.getSnapshot().dirty, true); assert.equal(editor.requestLeave(), false);
  assert.equal(await editor.save(), null); assert.equal(writes, 0);
  assert.equal(editor.getSnapshot().warning, "【圏外です】"); assert.equal(editor.getSnapshot().draft.details.depth, "55.5");
  online = true; await Promise.resolve(); assert.equal(writes, 0);
  assert.equal((await editor.save())?.details?.adminMemo, "保持するメモ"); assert.equal(writes, 1);
  editor.changeDetail("depth", "999"); editor.discard(); assert.equal(editor.getSnapshot().draft.details.depth, "55.5");
});
test("detail fields are cloned and only allowed field keys enter the draft", () => {
  const details: Record<string, string> = { ...previewItems[0].details, unexpectedToken: "do-not-retain" };
  const base = { ...previewItems[0], details };
  const draft = draftFor(base); details.depth = "999";
  assert.equal(draft.details.depth, "54.5"); assert.equal("unexpectedToken" in draft.details, false);
  const second = { ...draft, details: { ...draft.details } };
  assert.equal(sameDraft(draft, second), true); second.details.depth = "55"; assert.equal(sameDraft(draft, second), false);
  assert.deepEqual(copyDetailValues(["invalid"]), {});
});
test("shipping is editable and unknown fields cannot enter the draft", () => {
  const editor = new InventoryEditor(previewItems[0], { online: async () => true, newMutationId: () => "test", save: async () => previewItems[0] });
  editor.changeDetail("shippingCost", "9999"); editor.changeDetail("unexpectedToken", "bad");
  assert.equal(editor.getSnapshot().dirty, true);
  assert.equal(editor.getSnapshot().draft.details.shippingCost, "9999");
  assert.equal("unexpectedToken" in editor.getSnapshot().draft.details, false);
});
test("dates and monetary values reject impossible entries but preserve valid leap dates and zero", () => {
  const draft = draftFor(previewItems[0]);
  draft.details.saleEndDate = "2026/02/30"; assert.match(validateDraft(draft)!, /販売終了日/);
  draft.details.saleEndDate = "2024/02/29"; assert.equal(validateDraft(draft), null);
  draft.details.salePrice = "-10"; assert.match(validateDraft(draft)!, /販売価格/);
  draft.details.salePrice = "0"; assert.equal(validateDraft(draft), null);
});
test("staff cannot render sales or listing fields; independent permissions are honored", () => {
  const staff = visibleDetailFields({ ecListing: false, sales: false });
  assert.equal(staff.some(field => field.key === "salePrice" || field.key === "listingNotes"), false);
  assert.equal(staff.some(field => field.key === "width"), true);
  const salesOnly = visibleDetailFields({ ecListing: false, sales: true });
  assert.equal(salesOnly.some(field => field.key === "salePrice"), true);
  assert.equal(salesOnly.some(field => field.key === "listingNotes"), false);
});
test("list refresh preserves already read details only for the same version", () => {
  const item = previewItems[0]; const { details, photos, detailLoadedAt, ...listItem } = item;
  assert.deepEqual(mergeInventoryRead([item], [listItem])[0].details, details);
  assert.equal(mergeInventoryRead([item], [{ ...listItem, updatedAt: "2026-10-18T01:00:00Z" }])[0].details, undefined);
  assert.equal(mergeInventoryRead([item], [{ ...listItem, id: "different-item" }])[0].details, undefined);
});

test("fast reads show zero/one/multiple quantities immediately and preserve only same-version cached images", () => {
  const previous = previewItems.map(item => ({ ...item, thumbnailUrl: `https://example.test/${item.id}.jpg` }));
  const fresh = previous.map((item, index) => ({ ...item, quantity: [0, 1, 11][index], thumbnailUrl: null }));
  const merged = mergeInventoryRead(previous, fresh, true);
  assert.deepEqual(merged.map(item => item.quantity), [0, 1, 11]);
  assert.deepEqual(merged.map(item => item.thumbnailUrl), previous.map(item => item.thumbnailUrl));
  assert.equal(mergeInventoryRead(previous, [{ ...fresh[0], updatedAt: "2026-10-18T00:00:00Z" }], true)[0].thumbnailUrl, null);
  assert.equal(mergeInventoryRead(previous, fresh)[0].thumbnailUrl, null, "A confirmed absent image still clears the old one");
});

test("late images cannot change quantities, undo an edit or restore a deleted record", () => {
  const [first, second, third] = previewItems;
  const rows = [{ ...first, quantity: 0 }, { ...second, quantity: 1, updatedAt: "2026-10-18T00:00:00Z" }];
  const images = [first, second, third].map(item => ({ id: item.id, updatedAt: item.updatedAt, thumbnailUrl: `https://example.test/${item.id}.jpg` }));
  const merged = mergeInventoryThumbnails(rows, images);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].thumbnailUrl, images[0].thumbnailUrl);
  assert.equal(merged[0].quantity, 0);
  assert.equal(merged[1], rows[1], "Ignore the image belonging to an older server version");
  assert.equal(merged[1].quantity, 1);
});

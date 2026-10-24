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

test('QR movement replaces the other destination and preserves unrelated categories in one save',async()=>{
  const f=fixture(); f.editor.change('category','販売中，業者間,プラスロジ移動予定');
  const result=await f.editor.saveQrMovement(' 2026101900314 ','川越移動予定',['川越移動予定','プラスロジ移動予定']);
  assert.equal(f.calls.length,1);assert.equal(result?.barcode,'2026101900314');
  assert.equal(result?.category,'販売中,業者間,川越移動予定');
});
test('QR no-movement choice leaves existing movement unchanged',async()=>{
  const f=fixture(); f.editor.change('category','販売中,川越移動予定');
  const result=await f.editor.saveQrMovement('2026101900315',null,['川越移動予定','プラスロジ移動予定']);
  assert.equal(result?.category,'販売中,川越移動予定');
});
test('invalid QR rolls back QR and category draft but retains unrelated edits',async()=>{
  const f=fixture();f.editor.change('note','入力中のメモ'); const previous=f.editor.getSnapshot().draft;
  f.ports.save=async()=>{throw new InventoryWriteError('barcodeInvalid');};
  assert.equal(await f.editor.saveQrMovement('duplicate','川越移動予定',['川越移動予定','プラスロジ移動予定']),null);
  assert.equal(f.editor.getSnapshot().draft.barcode,previous.barcode);assert.equal(f.editor.getSnapshot().draft.category,previous.category);
  assert.equal(f.editor.getSnapshot().draft.note,'入力中のメモ');assert.match(f.editor.getSnapshot().warning!,/読み取れません/);
  assert.equal(f.editor.getSnapshot().outcomeUncertain,false);
});
test('offline QR flow sends nothing and returns both fields to their previous values',async()=>{
  const f=fixture();const previous=f.editor.getSnapshot().draft;f.setOnline(false);
  await f.editor.saveQrMovement('2026101900315','川越移動予定',['川越移動予定','プラスロジ移動予定']);
  assert.equal(f.calls.length,0);assert.equal(f.editor.getSnapshot().warning,OFFLINE_WARNING);
  assert.equal(f.editor.getSnapshot().draft.barcode,previous.barcode);assert.equal(f.editor.getSnapshot().draft.category,previous.category);
});
test('unknown QR write result retries original QR/category together, never an alternative choice',async()=>{
  const f=fixture(),seen:SaveRequest[]=[];const success=f.ports.save;
  f.ports.save=async r=>{seen.push(r);if(seen.length===1)throw new InventoryWriteError('uncertain');return success(r);};
  await f.editor.saveQrMovement('2026101900316','川越移動予定',['川越移動予定','プラスロジ移動予定']);
  assert.equal(f.editor.getSnapshot().outcomeUncertain,true);
  await f.editor.saveQrMovement('different',null,['川越移動予定','プラスロジ移動予定']);
  assert.deepEqual(seen[0],seen[1]);assert.equal(f.editor.getSnapshot().saved.barcode,'2026101900316');
  assert.match(f.editor.getSnapshot().saved.category,/川越移動予定/);
});

test("invalid inventory quantities never reach the save port", async () => {
  for (const quantity of ["-1", "1.5", "2147483648", "not-a-number"]) {
    const f = fixture(); f.editor.change("quantity", quantity);
    assert.equal(await f.editor.save(), null);
    assert.equal(f.calls.length, 0);
    assert.ok(f.editor.getSnapshot().warning);
    assert.equal(f.editor.getSnapshot().draft.quantity, quantity);
  }
});

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
  assert.equal(f.editor.discard(), false);
  assert.equal(f.editor.getSnapshot().leaveConfirmation, true);
  assert.equal(f.editor.getSnapshot().draft.quantity, "13");
  f.setOnline(false);
  assert.equal(await f.editor.save(), null);
  assert.equal(f.editor.discard(), false);
  assert.equal(seen.length, 1);
  f.setOnline(true);
  await f.editor.save(); assert.deepEqual(seen[0], seen[1]);
  assert.equal(f.editor.getSnapshot().outcomeUncertain, false);
  assert.equal(f.editor.requestLeave(), true);
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

test('single Photo Station image removal preserves unsaved inventory edits',async()=>{
 const f=fixture();const image={id:'asset1',source:'PHOTO_ASSET' as const,url:'photo.jpg',primary:true};
 const base={...f.base,photos:[image,{...image,id:'asset2',primary:false}]};let removed='';
 f.ports.deletePhotoAsset=async(_id,id)=>{removed=id};const editor=new InventoryEditor(base,f.ports);
 editor.change('note','未保存のメモ');await editor.deletePhotoAsset('asset1');
 assert.equal(removed,'asset1');assert.equal(editor.getSnapshot().draft.note,'未保存のメモ');
 assert.equal(editor.getSnapshot().dirty,true);assert.deepEqual(editor.getSnapshot().saved.photos?.map(p=>p.id),['asset2']);
 assert.equal(base.photos.length,2);
});
test('failed/offline Photo Station deletion retains image and clears saving state',async()=>{
 const f=fixture();const base={...f.base,photos:[{id:'asset1',source:'PHOTO_ASSET' as const,url:'photo.jpg',primary:true}]};let calls=0;
 f.ports.deletePhotoAsset=async()=>{calls++;throw Error('削除できません')};const editor=new InventoryEditor(base,f.ports);
 f.setOnline(false);await assert.rejects(()=>editor.deletePhotoAsset('asset1'));assert.equal(calls,0);
 f.setOnline(true);await assert.rejects(()=>editor.deletePhotoAsset('asset1'));assert.equal(calls,1);
 assert.equal(editor.getSnapshot().saved.photos?.length,1);assert.equal(editor.getSnapshot().saving,false);
});
test('parallel image delete is blocked until first result is known',async()=>{
 const f=fixture();let finish:()=>void=()=>{};f.ports.deletePhotoAsset=()=>new Promise<void>(r=>{finish=r});
 const editor=new InventoryEditor({...f.base,photos:[{id:'asset1',source:'PHOTO_ASSET' as const,url:'photo.jpg',primary:true}]},f.ports);
 const first=editor.deletePhotoAsset('asset1');await Promise.resolve();
 await assert.rejects(()=>editor.deletePhotoAsset('asset1'));finish();await first;
 assert.equal(editor.getSnapshot().saved.photos?.length,0);
});


test('same barcode can be saved on independent stock pages',async()=>{
 const a=fixture(),b=fixture();
 a.editor.change('quantity','3'); b.editor.change('quantity','2');
 const first=await a.editor.saveQrMovement('SHARED-PRODUCT',null,[]);
 const second=await b.editor.saveQrMovement('SHARED-PRODUCT',null,[]);
 assert.equal(first?.barcode,second?.barcode);
 assert.equal(first?.quantity,3);assert.equal(second?.quantity,2);
 assert.equal(a.editor.getSnapshot().warning,null);assert.equal(b.editor.getSnapshot().warning,null);
});

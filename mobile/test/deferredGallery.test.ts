import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InventoryEditor, type SaveRequest} from '../src/domain/editor';
import {isInventoryGallery, mergeInventoryGallery, type InventoryGallery} from '../src/domain/inventory';
import {previewItems} from '../src/preview/fixture';

const core = {...previewItems[0], photos: undefined, photosComplete: false, photosDeferred: true};
const gallery: InventoryGallery = {id: core.id, updatedAt: core.updatedAt, photosComplete: true,
  photos: [{id:'image-1',url:'https://example.com/photo.jpg',primary:true,source:'INVENTORY'}]};
function editor() {
  const requests:SaveRequest[]=[];
  const instance = new InventoryEditor(core, {online:async()=>true,newMutationId:()=> 'edit-1',save:async request=>{
    requests.push(request);
    return {...mergeInventoryGallery(core,gallery), name:request.draft.name,updatedAt:'2026-11-09T10:00:00Z'};
  }});
  return {instance,requests};
}
test('text can be edited and saved before gallery completes; omitted photos do not become removals',async()=>{
  const {instance,requests}=editor(); instance.change('name','変更後の商品名');
  const saved=await instance.save(); assert.equal(saved?.name,'変更後の商品名');
  assert.equal(requests.length,1);assert.equal(requests[0].expectedUpdatedAt,core.updatedAt);
  assert.equal(requests[0].removedPhotoIds?.length??0,0);assert.equal(saved?.photos?.length,1);
  instance.receiveGallery(gallery);assert.equal(instance.getSnapshot().saved.updatedAt,'2026-11-09T10:00:00Z');
});
test('late photos preserve dirty fields, pending uploads, and leave-confirmation',()=>{
  const {instance}=editor();instance.change('name','入力途中');instance.changeDetail('depth','71.5');
  instance.addPhotos([{id:'new',uri:'file:///pending.jpg',type:'DAMAGE'}]);instance.requestLeave();
  const before=instance.getSnapshot();instance.receiveGallery(gallery);const after=instance.getSnapshot();
  assert.equal(after.draft,before.draft);assert.equal(after.photos,before.photos);
  assert.equal(after.dirty,true);assert.equal(after.leaveConfirmation,true);assert.equal(after.saved.photosComplete,true);
});
test('different product or revision cannot replace the gallery',()=>{
  assert.equal(mergeInventoryGallery(core,{...gallery,id:'another'}),core);
  assert.equal(mergeInventoryGallery(core,{...gallery,updatedAt:'2026-11-09T10:00:00Z'}),core);
  const done=mergeInventoryGallery(core,gallery);assert.equal(mergeInventoryGallery(done,gallery),done);
});
test('photo failure leaves editing enabled and retry does not discard input',()=>{
  const {instance}=editor();instance.change('note','スタッフのメモ');instance.galleryFailed(core.id,core.updatedAt);
  assert.equal(instance.getSnapshot().saved.photosDeferred,false);assert.equal(instance.getSnapshot().saving,false);
  instance.retryGallery();instance.receiveGallery(gallery);
  assert.equal(instance.getSnapshot().draft.note,'スタッフのメモ');assert.equal(instance.getSnapshot().dirty,true);
});
test('partial sources cannot enable image removals',()=>{
  const {instance}=editor();instance.receiveGallery({...gallery,photosComplete:false});instance.removeSavedPhoto('image-1');
  assert.deepEqual(instance.getSnapshot().removedPhotoIds,[]);
});
test('complete gallery unlocks explicit photo removals only',()=>{
  const {instance}=editor();instance.removeSavedPhoto('image-1');assert.equal(instance.getSnapshot().dirty,false);
  instance.receiveGallery(gallery);instance.removeSavedPhoto('image-1');assert.deepEqual(instance.getSnapshot().removedPhotoIds,['image-1']);
});
test('empty complete gallery clears old thumbnail, partial result preserves it',()=>{
  assert.equal(mergeInventoryGallery(core,{...gallery,photos:[]}).thumbnailUrl,null);
  assert.equal(mergeInventoryGallery(core,{...gallery,photos:[],photosComplete:false}).thumbnailUrl,core.thumbnailUrl);
});
test('gallery transport validates timestamp, URL scheme, and photo structure',()=>{
  assert.equal(isInventoryGallery(gallery),true);
  for(const value of [null,{}, {...gallery,updatedAt:'bad'},{...gallery,photosComplete:'yes'},
    {...gallery,photos:[{...gallery.photos[0],url:'javascript:alert(1)'}]},
    {...gallery,photos:[{...gallery.photos[0],source:'UNKNOWN'}]}])assert.equal(isInventoryGallery(value),false);
});

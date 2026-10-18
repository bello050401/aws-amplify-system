import {test} from "node:test";
import assert from "node:assert/strict";
import {validPreparationImageRef} from "./preparationImageRef";
const batch="6fdfe11c-cfde-440b-a24e-a821e1839d03", id=batch+"#A#3413ec1a-9cc8-4f52-969a-6002e1fb0ea8";
const photo={source:"PHOTO_ASSET",photoAssetId:id,storageKey:`photo-batches/${batch}/processed/${id}.jpg`,sortOrder:0};
test("real Photo Station reference is accepted without mistaking #A# for a URL fragment",()=>assert.equal(validPreparationImageRef(photo,0),true));
test("wrong batch, external URLs, traversal and changed order remain rejected",()=>{
 for(const patch of [{storageKey:photo.storageKey.replace(batch,"another-batch")},{storageKey:"https://example.com/photo.jpg"},{photoAssetId:batch+"#A#../other"},{storageKey:photo.storageKey+"?x"},{sortOrder:1}]) assert.equal(validPreparationImageRef({...photo,...patch},0),false);
});
test("ordinary inventory references and old UUID assets remain readable",()=>{
 assert.equal(validPreparationImageRef({source:"INVENTORY",storageKey:"inventory/item/front.jpg",sortOrder:0},0),true);
 assert.equal(validPreparationImageRef({source:"PHOTO_ASSET",photoAssetId:batch,storageKey:"photos/front.jpg",sortOrder:0},0),true);
 assert.equal(validPreparationImageRef({...photo,source:"INVENTORY"},0),false);
});

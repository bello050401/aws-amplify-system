import assert from 'node:assert/strict';
import test from 'node:test';
import {initialPreviewPhotos} from '../src/domain/photoPreview';
const now=Date.parse('2026-11-11T01:00:00Z');
const signed=(stamp:string)=>`https://images.example/p.jpg?X-Amz-Date=${stamp}&X-Amz-Expires=900`;
test('expired full photos never hide a valid local thumbnail on first open',()=>{
  const result=initialPreviewPhotos([{id:'old',url:signed('20261110T010000Z'),fullUrl:signed('20261110T010000Z'),primary:true}],'blob:local-thumb',now);
  assert.deepEqual(result,[{id:'preview-thumbnail',url:'blob:local-thumb',primary:true}]);
});
test('valid preview is retained if only original has expired',()=>{
  const result=initialPreviewPhotos([{id:'one',url:'https://images.example/preview.jpg',fullUrl:signed('20261110T010000Z'),primary:true}],null,now);
  assert.equal(result[0].fullUrl,null);assert.equal(result[0].url,'https://images.example/preview.jpg');
});
test('fresh original and primary order remain intact, no source metadata mutation',()=>{
  const photos=[{id:'damage',url:'https://images.example/d.jpg',type:'DAMAGE' as const,primary:false},{id:'main',url:signed('20261111T005900Z'),primary:true}];
  const before=structuredClone(photos),result=initialPreviewPhotos(photos,null,now);
  assert.equal(result[0].id,'main');assert.deepEqual(photos,before);
});
test('no usable URL produces an empty pending viewer, never a known-expired request',()=>{
  assert.deepEqual(initialPreviewPhotos([{id:'one',url:signed('20261110T010000Z'),primary:true}],signed('20261110T010000Z'),now),[]);
});

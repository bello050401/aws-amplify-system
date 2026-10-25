import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {uploadSession} from '../src/client.mjs';

test('初回登録でも編集前写真を必ず保存してからバッチを完了する',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'bello-first-original-'));const paths={};for(const n of ['o','p','t']){paths[n]=path.join(dir,n+'.jpg');await writeFile(paths[n],n);}
 const calls=[],uploads=[];
 const api={call:async(op,input)=>{calls.push(op);if(op==='createPhotoBatch')return{batchId:'b'};if(op==='requestPhotoAssetUploads')return{items:[{kind:'CREATE_ASSET',photoAssetId:'a',clientAssetId:'a',uploads:[{variant:'PROCESSED'},{variant:'THUMBNAIL'}]}]};if(op==='completePhotoAssetUpload')return{status:'READY'};if(op==='requestOriginalPhotoUpload'){assert.equal(input.archiveId,'archive');return{status:'UPLOAD',upload:{variant:'ORIGINAL'}};}if(op==='completeOriginalPhotoUpload')return{status:'READY'};if(op==='completePhotoBatch')return{status:'READY_FOR_REVIEW'};throw Error(op);},upload:async(u,p)=>uploads.push([u.variant,p])};
 await uploadSession({api,deviceId:'d',sessionId:'s',assets:[{clientAssetId:'a',fileName:'o.jpg',originalPath:paths.o,processedPath:paths.p,thumbnailPath:paths.t,originalArchiveId:'archive'}]});
 assert.deepEqual(uploads.map(v=>v[0]),['PROCESSED','THUMBNAIL','ORIGINAL']);assert(calls.indexOf('completeOriginalPhotoUpload')<calls.indexOf('completePhotoBatch'));
});
test('原本は加工済み写真の再送時にも保存し、失敗中は完了にしない',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'bello-original-'));
 for(const [name,value] of [['original.jpg','untouched original'],['p.jpg','edited'],['t.jpg','thumb']])await writeFile(path.join(dir,name),value);
 let fail=true;const calls=[];let originalInput;
 const api={call:async(op,input)=>{
  calls.push(op);
  if(op==='createPhotoBatch')return{batchId:'b',batchCode:'B'};
  if(op==='requestPhotoAssetUploads')return{items:[{kind:'ALREADY_READY',photoAssetId:'a',clientAssetId:'a'}]};
  if(op==='requestOriginalPhotoUpload'){originalInput=input.original;return{status:'UPLOAD',upload:{}};}
  if(op==='completeOriginalPhotoUpload')return{status:'READY'};
  if(op==='completePhotoBatch')return{status:'READY_FOR_REVIEW'};
  throw Error(op);
 },upload:async(_,file)=>{assert.equal(await readFile(file,'utf8'),'untouched original');if(fail)throw Error('network');}};
 const input={api,deviceId:'d',sessionId:'s',assets:[{clientAssetId:'a',fileName:'original.jpg',originalPath:path.join(dir,'original.jpg'),processedPath:path.join(dir,'p.jpg'),thumbnailPath:path.join(dir,'t.jpg'),importedAt:'2026-10-24T00:00:00.000Z'}]};
 await assert.rejects(uploadSession(input),/network/);
 assert(!calls.includes('completePhotoBatch'));
 fail=false;calls.length=0;
 assert.equal((await uploadSession(input)).status,'READY_FOR_REVIEW');
 assert(calls.indexOf('completeOriginalPhotoUpload')<calls.indexOf('completePhotoBatch'));
 assert.equal(originalInput.importedAt,'2026-10-24T00:00:00.000Z');
 assert.equal(originalInput.fileSize,18);
});

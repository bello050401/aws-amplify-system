import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {archiveOriginalSources} from '../src/originalArchive.mjs';
test('現像前に原本を保管し再実行では原本を二重アップロードしない',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'bello-archive-'));
 const imported='2026-10-24T00:00:00.000Z';
 await writeFile(path.join(root,'source-retention.json'),JSON.stringify({version:1,importedAt:imported,expiresAt:'2026-10-31T00:00:00.000Z'}));
 const file=path.join(root,'a.jpg');await writeFile(file,'source');
 let ready=false,puts=0;
 const api={call:async(op,input)=>{
  if(op==='requestTemporaryOriginal'){assert.equal(input.importedAt,imported);return{status:ready?'READY':'UPLOAD',id:'a',upload:{}};}
  assert.equal(op,'completeTemporaryOriginal');ready=true;return{status:'READY'};
 },upload:async(_,p)=>{assert.equal(p,file);puts++;}};
 const args={api,sessionId:'s',deviceId:'d',sources:[{clientAssetId:'a',fileName:'a.jpg',sourcePath:file}],outputRoot:root};
 assert.equal((await archiveOriginalSources(args)).status,'ORIGINALS_ARCHIVED');
 await archiveOriginalSources(args);assert.equal(puts,1);
 api.call=async()=>({status:'EXPIRED'});await assert.rejects(archiveOriginalSources(args),/保管されていません/);
});

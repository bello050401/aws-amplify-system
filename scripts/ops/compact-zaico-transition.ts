/** Storage-only migration. Deploy every decoder before apply. Roll back storage
 * before deploying an old reader. Never restore a stale backup over live state.
 * Usage: ... compact-zaico-transition.ts measure|apply|verify|rollback
 * apply/rollback additionally require --readers-deployed (operator attestation).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,TransactWriteCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-providers';
import {encodeTransitionRecord as encode,decodeTransitionRecord as decode} from '../../lib/zaico/transition/recordEncoding';
import {transitionStore,CONTROL_ID,LEASE_ID,ITEM_PREFIX} from '../../lib/zaico/transition/store';
import type {Row} from '../../lib/zaico/transition/mapping';

const table='ZaicoTransitionRecord-j6up24p7lnczdmklzjdt3vrp4y-NONE';
const bucket='amplify-d4hkkg7dty2du-cla-belloinventorystoragebuc-tou1f1birq9x';
const config={region:'us-west-2',credentials:fromIni({profile:'Bello'}),maxAttempts:3};
const db=DynamoDBDocumentClient.from(new DynamoDBClient(config),{marshallOptions:{removeUndefinedValues:true}});
const s3=new S3Client(config),store=transitionStore(db,table);
const mode=process.argv[2],stamp=new Date().toISOString().replace(/[:.]/g,'-');
const dir=path.resolve('artifacts/zaico-read-cost-20261107');
fs.mkdirSync(dir,{recursive:true});
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function canonical(v:any):any {
 if(Array.isArray(v))return v.map(canonical);
 if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
 return v;
}
const logicalHash=(rows:Row[])=>sha(JSON.stringify(rows.map(decode).sort((a,b)=>a.id.localeCompare(b.id)).map(canonical)));
async function scan(){
 const rows:Row[]=[];let cursor:Record<string,any>|undefined,rcu=0,pages=0;const started=Date.now();
 do{
  const p:ScanCommandOutput=await db.send(new ScanCommand({TableName:table,ConsistentRead:true,ReturnConsumedCapacity:'TOTAL',ExclusiveStartKey:cursor}));
  rows.push(...p.Items??[]);rcu+=p.ConsumedCapacity?.CapacityUnits??0;pages++;cursor=p.LastEvaluatedKey;
  if(pages%10===0)console.log(JSON.stringify({scanPages:pages,rows:rows.length}));
 }while(cursor);
 return {rows,rcu,pages,durationMs:Date.now()-started};
}
function report(result:Awaited<ReturnType<typeof scan>>){
 const items=result.rows.filter(r=>r.id.startsWith(ITEM_PREFIX));
 let plainBytes=0,compressedPayloadBytes=0,encodeMs=0,decodeMs=0,eligible=0,compressed=0;
 for(const row of items){
  const plain=decode(row);let t=performance.now();const compact=encode(plain);encodeMs+=performance.now()-t;
  t=performance.now();const restored=decode(compact);decodeMs+=performance.now()-t;
  assert.deepEqual(restored,plain);
  assert.deepEqual(JSON.parse(JSON.stringify(plain)),plain,'Backup must be lossless JSON');
  plainBytes+=Buffer.byteLength(JSON.stringify(plain));
  compressedPayloadBytes+=compact.snapshotGzip?.byteLength??0;
  if(compact.snapshotEncoding)eligible++;
  if(row.snapshotEncoding)compressed++;
 }
 const c=result.rows.find(r=>r.id===CONTROL_ID);
 return {at:new Date().toISOString(),table,totalRows:result.rows.length,items:items.length,eligible,compressed,
  strongScanReadUnits:result.rcu,pages:result.pages,durationMs:result.durationMs,
  plainJsonBytes:plainBytes,compressedPayloadBytes,encodeMs:Math.round(encodeMs),decodeMs:Math.round(decodeMs),
  logicalHash:logicalHash(items),phase:c?.phase,pollMinutes:c?.pollMinutes,compactItemPayloads:c?.compactItemPayloads===true,
  lastSuccessfulPullAt:c?.lastSuccessfulPullAt,lastError:c?.lastError,summary:c?.summary};
}
async function main(){
 if(mode==='health'){
  const c=await store.get(CONTROL_ID);const issues=[];
  for(const id of c?.issueIds??[]){const s=await store.get(ITEM_PREFIX+id);issues.push({inventoryId:id,status:s?.status,error:s?.error});}
  console.log(JSON.stringify({phase:c?.phase,pollMinutes:c?.pollMinutes,nextRunAt:c?.nextRunAt,work:!!c?.work,lastSuccessfulPullAt:c?.lastSuccessfulPullAt,
   lastError:c?.lastError,compactItemPayloads:c?.compactItemPayloads===true,summary:c?.summary,issues}));return;
 }
 if(!['measure','verify','apply','rollback'].includes(mode))throw Error('Choose measure|verify|apply|rollback|health');
 if(mode==='measure'||mode==='verify'){
  const r=report(await scan());fs.writeFileSync(path.join(dir,`${mode}-${stamp}.json`),JSON.stringify(r,null,2));console.log(JSON.stringify(r));return;
 }
 if(!process.argv.includes('--readers-deployed'))throw Error('Deploy and verify all readers before migration');
 if(process.argv.includes('--wait-for-window')){
  const until=Date.now()+15*60_000;let loops=0;
  for(;;){
   const c=await store.get(CONTROL_ID),lease=await store.get(LEASE_ID);
   if(c?.phase!=='ACTIVE')throw Error('Integration is not ACTIVE');
   if(!c.work&&(c.nextRunAt??0)-Date.now()>180_000&&(!lease||lease.expiresAt<Date.now()))break;
   if(Date.now()>until)throw Error('No safe migration window within 15 minutes');
   if(loops++%6===0)console.log(JSON.stringify({waitingForSync:true,lastSuccessfulPullAt:c.lastSuccessfulPullAt}));
   await new Promise(resolve=>setTimeout(resolve,5000));
  }
 }
 const owner='storage-'+randomUUID();if(!await store.acquire(owner))throw Error('Sync is running. Retry after it finishes.');
 try{
  const control=await store.get(CONTROL_ID);
  if(control?.phase!=='ACTIVE'||control.work)throw Error('Only an idle ACTIVE integration can be migrated');
  if((control.nextRunAt??0)-Date.now()<180_000)throw Error('Too close to next synchronization. Retry just after it completes.');
  const deadline=Math.min(Date.now()+150_000,control.nextRunAt-30_000);
  const before=await scan(),rows=before.rows.filter(r=>r.id.startsWith(ITEM_PREFIX));
  const baseline=report(before); // verify every payload before any write
  const backup=gzipSync(Buffer.from(JSON.stringify({at:stamp,table,control,items:rows.map(decode)})));
  const key=`zaico-transition/storage-compaction/${stamp}-${mode}.json.gz`;
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:backup,ContentType:'application/gzip',ServerSideEncryption:'AES256',
   IfNoneMatch:'*',ChecksumSHA256:createHash('sha256').update(backup).digest('base64')}));
  const read=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  const backupRead=Buffer.from(await read.Body!.transformToByteArray());
  assert.equal(sha(backupRead),sha(backup));assert.equal(logicalHash(JSON.parse(gunzipSync(backupRead).toString()).items),baseline.logicalHash);
  fs.writeFileSync(path.join(dir,`${mode}-${stamp}-backup.json`),JSON.stringify({bucket,key,sha256:sha(backup),baseline},null,2));
  const changes=rows.map(row=>({before:row,after:mode==='apply'?encode(row):decode(row)})).filter(c=>c.before.snapshotEncoding!==c.after.snapshotEncoding);
  let changed=0;
  // Serialize transactions: they all condition-check the same lease and must
  // not contend with one another. Limit burst writes on the on-demand table.
  // CAS and unchanged versions prevent overwriting concurrent business edits.
  for(let start=0;start<changes.length;start+=25){
   if(Date.now()>deadline)throw Error('Migration paused before the next sync; mixed formats are safe. Re-run to finish.');
   const batch=changes.slice(start,start+25);
   const request=new TransactWriteCommand({ClientRequestToken:randomUUID(),TransactItems:[{ConditionCheck:{TableName:table,Key:{id:LEASE_ID},ConditionExpression:'#o=:o AND expiresAt>:now',
    ExpressionAttributeNames:{'#o':'owner'},ExpressionAttributeValues:{':o':owner,':now':Date.now()+25_000}}},
    ...batch.map(c=>({Put:{TableName:table,Item:c.after,ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':c.before.version}}}))]});
   for(let retry=0;;retry++){
    try{await db.send(request);break;}catch(e){
     const reasons=(e as any).CancellationReasons as {Code?:string}[]|undefined;
     const transient=(e as any).name==='TransactionCanceledException'&&reasons?.some(r=>['TransactionConflict','ThrottlingError','ProvisionedThroughputExceeded'].includes(r.Code??''))&&
      reasons.every(r=>['None','TransactionConflict','ThrottlingError','ProvisionedThroughputExceeded'].includes(r.Code??'None'));
     if(!transient||retry>=3||Date.now()+2000>deadline)throw e;
     await new Promise(resolve=>setTimeout(resolve,400*2**retry));
    }
   }
   changed+=batch.length;
   if(changed%500===0)console.log(JSON.stringify({mode,changed,total:changes.length}));
   await new Promise(resolve=>setTimeout(resolve,150));
  }
  const after=await scan(),verified=report(after);assert.equal(verified.logicalHash,baseline.logicalHash,'No logical state may change');
  await store.assertLease(owner);
  await store.put({...control,compactItemPayloads:mode==='apply'},control.version);
  const result={mode,changed,backup:{bucket,key,sha256:sha(backup),bytes:backup.length},before:baseline,after:{...verified,compactItemPayloads:mode==='apply'},
   readReductionPercent:Number((100*(1-verified.strongScanReadUnits/baseline.strongScanReadUnits)).toFixed(2)),logicalStateUnchanged:true,
   pollingIntervalUnchanged:true,finishedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(dir,`${mode}-${stamp}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await store.release(owner);}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Migration failed');process.exitCode=1});

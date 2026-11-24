import test from 'node:test';
import assert from 'node:assert/strict';
import {ageDesktopJob,claimDesktopJob,DESKTOP_RETRY_MS,desktopCausalSnapshotMatches,desktopJobId,desktopSnapshot,finishDesktopJob,newDesktopJob,startDesktopWrite,comparableDesktopTitle,recordDesktopIssue,desktopIssueDiagnostic,expectedDesktopBoundaryError,type DesktopRequest,type DesktopJob,type DesktopEvidence} from './desktopJobModel';
import {createDesktopJobStore} from './desktopJobStore';
import {GetCommand,PutCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {canReuseMercariIdentification,completedDesktopStockReceipt,desktopSuccessorWakeWrites} from './desktopCompletion';
import {postSaleJobSaveRequest,type PostSaleJob} from './postSaleQueueCore';
import type {SaleCandidate} from './model';
import {DEFAULT_FEES} from './model';
import {automaticSaleDecision} from './automationPolicy';
import {runAutomaticSale,type AutomationJob,type AutomationPorts} from './automationCore';
import {assertDesktopIdentificationInventory,assertDesktopIdentificationOrder} from './desktopIdentification';
import type {PostSalePlan} from './postSaleModel';
const now=Date.parse('2026-11-21T00:00:00Z');
const request:DesktopRequest={purpose:'STOCK',candidateId:'a'.repeat(64),inventoryId:'inventory-1',inventoryVersion:'v1',externalId:'mercari-1',title:'【在庫3】椅子',imageKeys:['inventory/chair.jpg'],orderId:'order-1',orderLineId:'line-1',targetQuantity:3};
const proof=(job:DesktopJob,at=now):DesktopEvidence=>({snapshot:job.snapshot,externalId:job.externalId,inventoryId:job.inventoryId,orderId:job.orderId,orderLineId:job.orderLineId,observedTitle:'【在庫5】椅子',expectedImageKey:job.imageKeys[0],titleMatched:true,imageMatched:true,observedEvidenceRef:'screenshots/mercari-before.png',observedAt:new Date(at).toISOString(),observedQuantity:3,observedState:'ACTIVE'});
test('desktop listing scans empty pages only, preserves the complete matching page and its cursor',async()=>{
 const job=newDesktopJob(request,now),other=newDesktopJob({...request,candidateId:'b'.repeat(64)},now),keys=[{pk:'one'},{pk:'two'},{pk:'three'}],calls:ScanCommand[]=[];
 const pages=[{Items:[],LastEvaluatedKey:keys[0]},{Items:[],LastEvaluatedKey:keys[1]},{Items:[job,other],LastEvaluatedKey:keys[2]}];
 const store=createDesktopJobStore({send:async command=>{assert(command instanceof ScanCommand);calls.push(command);return pages[calls.length-1];}},'jobs');
 const result=await store.list();assert.deepEqual(result.jobs,[job,other]);assert.equal(result.cursor,Buffer.from(JSON.stringify(keys[2])).toString('base64url'));assert.equal(calls.length,3);
 assert.deepEqual(calls.map(c=>c.input.ExclusiveStartKey),[undefined,keys[0],keys[1]]);assert(calls.every(c=>c.input.Limit===100));
});
test('desktop listing returns an exact continuation after eight empty pages and resumes supplied cursor',async()=>{
 const calls:ScanCommand[]=[],keys=Array.from({length:9},(_,i)=>({pk:'key-'+i})),cursor=Buffer.from(JSON.stringify(keys[0])).toString('base64url');
 const store=createDesktopJobStore({send:async command=>{assert(command instanceof ScanCommand);calls.push(command);return {Items:[],LastEvaluatedKey:keys[calls.length]};}},'jobs');
 const result=await store.list(cursor);assert.deepEqual(result.jobs,[]);assert.equal(calls.length,8);assert.deepEqual(calls[0].input.ExclusiveStartKey,keys[0]);assert.deepEqual(calls[7].input.ExclusiveStartKey,keys[7]);assert.equal(result.cursor,Buffer.from(JSON.stringify(keys[8])).toString('base64url'));
});
test('desktop listing stops at end of empty scan and rejects malformed cursors before database access',async()=>{
 let calls=0;const store=createDesktopJobStore({send:async command=>{assert(command instanceof ScanCommand);calls++;return calls===1?{LastEvaluatedKey:{pk:'next'}}:{};}},'jobs');
 assert.deepEqual(await store.list(),{jobs:[],cursor:null});assert.equal(calls,2);
 for(const cursor of [Buffer.from('{bad').toString('base64url'),Buffer.from('{"other":"key"}').toString('base64url'),'x'.repeat(1001)])await assert.rejects(()=>store.list(cursor),/DESKTOP_CURSOR_INVALID/);
 assert.equal(calls,2);
});
test('stable operation identity binds changing snapshot without creating another instruction',()=>{
 const j=newDesktopJob(request,now),next={...request,inventoryVersion:'v2'};
 assert.equal(desktopJobId(request),desktopJobId(next));assert.notEqual(j.snapshot,desktopSnapshot(next));
 for(const patch of [{externalId:'other'},{orderId:'other'},{orderLineId:'other'},{imageKeys:['inventory/other.jpg']},{targetQuantity:2}])assert.notEqual(j.snapshot,desktopSnapshot({...request,...patch}));
});
test('PC availability retries exactly every six hours, four windows, then attention',()=>{
 let j=newDesktopJob(request,now);assert.equal(j.attempts,1);assert.equal(ageDesktopJob(j,now+DESKTOP_RETRY_MS-1),j);
 for(let attempt=2;attempt<=4;attempt++){j=ageDesktopJob(j,now+(attempt-1)*DESKTOP_RETRY_MS);assert.equal(j.attempts,attempt);assert.equal(j.state,'WAITING');assert.equal(j.id,desktopJobId(request));}
 j=ageDesktopJob(j,now+4*DESKTOP_RETRY_MS);assert.equal(j.state,'ATTENTION');assert.equal(j.attempts,4);
 assert.equal(ageDesktopJob(j,now+99*DESKTOP_RETRY_MS),j);
});
test('same actor claim replay stable; other actor and stale lease blocked',()=>{
 const j=claimDesktopJob(newDesktopJob(request,now),'admin-a',now);
 assert.equal(claimDesktopJob(j,'admin-a',now+1),j);
 assert.throws(()=>claimDesktopJob(j,'admin-b',now+1),/BUSY/);
 assert.throws(()=>startDesktopWrite(j,'admin-b',j.lease!,proof(j),now),/LEASE_CHANGED/);
 assert.throws(()=>startDesktopWrite(j,'admin-a','bad',proof(j),now),/LEASE_CHANGED/);
 const aged=ageDesktopJob(j,now+16*60000);assert.equal(aged.state,'WAITING');assert.equal(aged.lease,undefined);
});

test('expired PC claims cannot extend the original four availability windows',()=>{
 let j=newDesktopJob(request,now);
 for(let window=0;window<4;window++){
  const at=now+window*DESKTOP_RETRY_MS;
  j=ageDesktopJob(j,at);assert.equal(j.attempts,window+1);
  j=claimDesktopJob(j,'admin-a',at);
  j=ageDesktopJob(j,at+16*60000);
  assert.equal(j.state,'WAITING');assert.equal(j.nextAt,now+(window+1)*DESKTOP_RETRY_MS);
 }
 j=ageDesktopJob(j,now+4*DESKTOP_RETRY_MS);assert.equal(j.state,'ATTENTION');assert.equal(j.attempts,4);
 const legacyShifted={...newDesktopJob(request,now),nextAt:now+8*DESKTOP_RETRY_MS};
 assert.equal(ageDesktopJob(legacyShifted,now+4*DESKTOP_RETRY_MS).state,'ATTENTION');
 const active=claimDesktopJob(newDesktopJob(request,now),'admin-a',now+4*DESKTOP_RETRY_MS-60000);
 assert.equal(ageDesktopJob(active,now+4*DESKTOP_RETRY_MS),active);
 assert.equal(ageDesktopJob(active,now+4*DESKTOP_RETRY_MS+16*60000).state,'ATTENTION');
});
test('title and image identity required before write reservation',()=>{
 const j=claimDesktopJob(newDesktopJob(request,now),'admin-a',now);
 for(const patch of [{externalId:'other'},{inventoryId:'other'},{orderId:'other'},{orderLineId:'other'},{snapshot:'other'},{expectedImageKey:'inventory/other.jpg'},{observedTitle:'机'},{imageMatched:false},{titleMatched:false},{observedEvidenceRef:j.imageKeys[0]},{observedAt:new Date(now-1000).toISOString()},{observedAt:new Date(now+6*60000).toISOString()}])assert.throws(()=>startDesktopWrite(j,'admin-a',j.lease!,{...proof(j),...patch},now),/EVIDENCE_MISMATCH/);
 const started=startDesktopWrite(j,'admin-a',j.lease!,proof(j),now);assert.deepEqual(started.preWriteEvidence,proof(j));
});
test('lost external acknowledgement never permits another write; expired lease is readback only',()=>{
 const claimed=claimDesktopJob(newDesktopJob(request,now),'admin-a',now),started=startDesktopWrite(claimed,'admin-a',claimed.lease!,proof(claimed),now);
 assert.equal(ageDesktopJob(started,now+10*DESKTOP_RETRY_MS),started);
 const reclaimed=claimDesktopJob(started,'admin-b',now+16*60000);assert.equal(reclaimed.state,'WRITE_STARTED');
 assert.throws(()=>startDesktopWrite(reclaimed,'admin-b',reclaimed.lease!,proof(reclaimed,now+16*60000),now+16*60000),/RECONCILE_ONLY/);
 const done=finishDesktopJob(reclaimed,'admin-b',reclaimed.lease!,{...proof(reclaimed,now+16*60000),observedEvidenceRef:'screenshots/after.png'},now+16*60000);assert.equal(done.state,'COMPLETE');
 assert.equal(ageDesktopJob(done,now+20*DESKTOP_RETRY_MS),done);assert.throws(()=>claimDesktopJob(done,'admin-b',now+1),/NOT_CLAIMABLE/);
});
test('completion needs exact absolute stock and STOP readback',()=>{
 const j=claimDesktopJob(newDesktopJob(request,now),'admin-a',now);
 assert.throws(()=>finishDesktopJob(j,'admin-a',j.lease!,{...proof(j),observedQuantity:2},now),/READBACK_REQUIRED/);
 const stop=claimDesktopJob(newDesktopJob({...request,targetQuantity:0},now),'admin-a',now);
 assert.throws(()=>finishDesktopJob(stop,'admin-a',stop.lease!,{...proof(stop),observedQuantity:0},now),/READBACK_REQUIRED/);
 assert.equal(finishDesktopJob(stop,'admin-a',stop.lease!,{...proof(stop),observedQuantity:0,observedState:'STOPPED'},now).state,'COMPLETE');
});
test('lost completion ACK accepts only identical durable receipt',()=>{
 const j=claimDesktopJob(newDesktopJob({...request,purpose:'VERIFY_SALE',targetQuantity:undefined},now),'admin-a',now),e=proof(j),done=finishDesktopJob(j,'admin-a',j.lease!,e,now);
 assert.equal(finishDesktopJob(done,'admin-a',j.lease!,e,now+100),done);
 assert.throws(()=>finishDesktopJob(done,'admin-a',j.lease!,{...e,observedEvidenceRef:'another/screenshot.png'},now),/RECEIPT_CHANGED/);
});
test('IDENTIFY receipt binds immutable order while resolving exact inventory/listing/photo',()=>{
 const j=claimDesktopJob(newDesktopJob({...request,purpose:'IDENTIFY_SALE',externalId:'ORDER:order-1',inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',imageKeys:[],targetQuantity:undefined},now),'admin-a',now);
 const e={...proof(j),externalId:'mercari-1',inventoryId:'inventory-1',inventoryVersion:'v1',expectedImageKey:'inventory/chair.jpg'};
 assert.equal(finishDesktopJob(j,'admin-a',j.lease!,e,now).state,'COMPLETE');
 assert.throws(()=>finishDesktopJob(j,'admin-a',j.lease!,{...e,orderId:'other'},now),/EVIDENCE_MISMATCH/);
});
test('internal stock/sold channel prefixes do not change product identity',()=>{
 assert.equal(comparableDesktopTitle('【BASE】【在庫３】 椅子'),comparableDesktopTitle('【在庫5】 椅子'));
 assert.notEqual(comparableDesktopTitle('椅子 A'),comparableDesktopTitle('椅子 B'));
});

function memoryDb(){
 const rows=new Map<string,Record<string,unknown>>();const copy=<T>(v:T):T=>v===undefined?v:structuredClone(v);const key=(table:string|undefined,k:Record<string,unknown>|undefined)=>{if(!table||!k)throw Error('INVALID_TEST_KEY');return table+':'+String(k.pk??k.id);};
 type Conditional={TableName?:string;Key?:Record<string,unknown>;Item?:Record<string,unknown>;ConditionExpression?:string;ExpressionAttributeValues?:Record<string,unknown>};
 const valid=(w:Conditional)=>{const v=rows.get(key(w.TableName,w.Key??w.Item)),c=w.ConditionExpression??'',x=w.ExpressionAttributeValues??{};
  const supported=['attribute_not_exists(pk)','attribute_not_exists(pk) OR #s=:released','#v=:v','updatedAt=:v','#s=:p AND updatedAt=:v','attribute_not_exists(pk) OR jobId=:id','attribute_exists(id) AND candidateId=:candidate AND #s=:active AND #v=:previous','attribute_exists(id) AND candidateId=:candidate AND #s=:active AND #v=:previous AND #t=:token','attribute_exists(id) AND candidateId=:candidate AND #s=:active AND attribute_not_exists(#v) AND #t=:token','#t=:t AND #s=:active AND #v=:v','#t=:t AND #s=:active AND attribute_not_exists(#v)'];
  if(!supported.includes(c))throw Error('UNSUPPORTED_TEST_CONDITION_'+c);
  if(c==='attribute_not_exists(pk)'&&v)throw Error('ConditionalCheckFailedException');
  if(c==='attribute_not_exists(pk) OR #s=:released'&&v&&v.state!==x[':released'])throw Error('ConditionalCheckFailedException');
  if(c==='#v=:v'&&v?.version!==x[':v'])throw Error('ConditionalCheckFailedException');
  if(c==='updatedAt=:v'&&v?.updatedAt!==x[':v'])throw Error('ConditionalCheckFailedException');
  if(c==='#s=:p AND updatedAt=:v'&&(v?.state!==x[':p']||v?.updatedAt!==x[':v']))throw Error('ConditionalCheckFailedException');
  if(c.startsWith('attribute_exists(id) AND candidateId=:candidate AND #s=:active')&&(!v||v.candidateId!==x[':candidate']||v.state!==x[':active']||(':previous'in x?v.version!==x[':previous']:v.version!==undefined)||':token'in x&&v.token!==x[':token']))throw Error('ConditionalCheckFailedException');
  if(c.startsWith('#t=:t AND #s=:active AND ')&&(!v||v.token!==x[':t']||v.state!==x[':active']||(':v'in x?v.version!==x[':v']:v.version!==undefined)))throw Error('ConditionalCheckFailedException');
  if(c==='attribute_not_exists(pk) OR jobId=:id'&&v&&v.jobId!==x[':id'])throw Error('ConditionalCheckFailedException');
 };
 return {rows,send:async(command:GetCommand|PutCommand|ScanCommand|TransactWriteCommand)=>{
  if(command instanceof GetCommand){const i=command.input;return {Item:copy(rows.get(key(i.TableName,i.Key)))};}
  if(command instanceof PutCommand){const i=command.input;valid(i);rows.set(key(i.TableName,i.Item),copy(i.Item!));return {};}
  if(command instanceof TransactWriteCommand){const i=command.input;for(const w of i.TransactItems??[])valid((w.Put??w.Update??w.Delete??w.ConditionCheck)!);for(const w of i.TransactItems??[]){if(w.Put)rows.set(key(w.Put.TableName,w.Put.Item),copy(w.Put.Item!));if(w.Update){const k=key(w.Update.TableName,w.Update.Key),v=w.Update.ExpressionAttributeValues??{};rows.set(k,w.Update.UpdateExpression?.includes('nextAt')?{...rows.get(k),...w.Update.Key,nextAt:v[':zero'],version:v[':next'],updatedAt:v[':at']}:{...rows.get(k),...w.Update.Key,state:v[':released'],jobId:v[':id'],releasedAt:v[':at']});}if(w.Delete)rows.delete(key(w.Delete.TableName,w.Delete.Key));}return {};}
  throw Error('UNEXPECTED_COMMAND_'+command.constructor.name);
 }};
}
test('CAS prevents duplicate claims, and remote lock serializes distinct orders',async()=>{
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now);db.rows.set('inventory:inventory-1',{id:'inventory-1',updatedAt:'v1'});
 const a=await store.ensure(request);assert.equal((await store.ensure(request)).job.id,a.job.id);assert.equal(db.rows.size,2);
 const claims=await Promise.allSettled([store.claim(a.job.id,'admin-a'),store.claim(a.job.id,'admin-b')]);assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
 const winner=(claims.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<DesktopJob>).value;
 await store.startWrite(winner.id,winner.actor!,winner.lease!,proof(winner),{table:'inventory',id:'inventory-1',version:'v1'});
 const b=await store.ensure({...request,candidateId:'b'.repeat(64)}),other=await store.claim(b.job.id,'admin-b');
 await assert.rejects(()=>store.startWrite(other.id,'admin-b',other.lease!,proof(other),{table:'inventory',id:'inventory-1',version:'v1'}));
 assert.equal((await store.get(other.id))?.state,'CLAIMED');
 const started=(await store.get(winner.id))!;await store.finish(started.id,started.actor!,started.lease!,{...proof(started),observedEvidenceRef:'screenshots/after.png'});
 assert.equal(db.rows.get('jobs:SALE_DESKTOP_REMOTE#mercari-1')?.state,'RELEASED');
 await store.startWrite(other.id,'admin-b',other.lease!,proof(other),{table:'inventory',id:'inventory-1',version:'v1'});
 await store.finish(started.id,started.actor!,started.lease!,{...proof(started),observedEvidenceRef:'screenshots/after.png'});
 assert.equal(db.rows.get('jobs:SALE_DESKTOP_REMOTE#mercari-1')?.state,'ACTIVE');assert.equal(db.rows.get('jobs:SALE_DESKTOP_REMOTE#mercari-1')?.jobId,other.id);
});
test('atomic inventory-version check rejects stale target before any write reservation',async()=>{
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now);const {job}=await store.ensure(request),j=await store.claim(job.id,'admin');db.rows.set('inventory:inventory-1',{updatedAt:'v2'});
 await assert.rejects(()=>store.startWrite(j.id,'admin',j.lease!,proof(j),{table:'inventory',id:'inventory-1',version:'v1'}));
 assert.equal((await store.get(j.id))?.state,'CLAIMED');assert.equal(db.rows.has('jobs:SALE_DESKTOP_REMOTE#mercari-1'),false);
});
test('IDENTIFY candidate enrichment and completion commit atomically; stale/deleted order remains untouched',async()=>{
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now);
 const {job}=await store.ensure({...request,purpose:'IDENTIFY_SALE',externalId:'ORDER:order-1',inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',imageKeys:[],targetQuantity:undefined}),j=await store.claim(job.id,'admin');
 const e={...proof(j),externalId:'mercari-1',inventoryId:'inventory-1',inventoryVersion:'v1',expectedImageKey:'inventory/chair.jpg'};
 db.rows.set('candidates:candidate-1',{id:'candidate-1',state:'DELETED',updatedAt:'changed'});
 const patch={Put:{TableName:'candidates',Item:{id:'candidate-1',state:'PENDING',updatedAt:'v2',externalListingId:'mercari-1'},ConditionExpression:'#s=:p AND updatedAt=:v',ExpressionAttributeValues:{':p':'PENDING',':v':'v1'}}};
 await assert.rejects(()=>store.finish(j.id,'admin',j.lease!,e,[patch]));assert.equal((await store.get(j.id))?.state,'CLAIMED');assert.equal(db.rows.get('candidates:candidate-1')?.state,'DELETED');
 db.rows.set('candidates:candidate-1',{id:'candidate-1',state:'PENDING',updatedAt:'v1'});
 assert.equal((await store.finish(j.id,'admin',j.lease!,e,[patch])).state,'COMPLETE');assert.equal(db.rows.get('candidates:candidate-1')?.externalListingId,'mercari-1');
});
test('causal rebase only changes version before write, invalidates former lease, and never clears uncertain write',async()=>{
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now),{job}=await store.ensure(request),j=await store.claim(job.id,'admin');
 await assert.rejects(()=>store.rebase(j,{...request,inventoryVersion:'v2',targetQuantity:2}),/REBASE_FORBIDDEN/);
 await assert.rejects(()=>store.rebase(j,{...request,inventoryVersion:'v2',imageKeys:['inventory/other.jpg']}),/REBASE_FORBIDDEN/);
 const rebased=await store.rebase(j,{...request,inventoryVersion:'v2'});assert.equal(rebased.state,'WAITING');assert.equal(rebased.lease,undefined);assert.equal(rebased.id,j.id);
 const claimed=await store.claim(j.id,'admin');db.rows.set('inventory:inventory-1',{updatedAt:'v2'});
 const started=await store.startWrite(claimed.id,'admin',claimed.lease!,proof(claimed),{table:'inventory',id:'inventory-1',version:'v2'});
 await assert.rejects(()=>store.rebase(started,{...request,inventoryVersion:'v3'}),/REBASE_FORBIDDEN/);
});
test('causal Yahoo settlement stock-count title change preserves same pending/started/completed operation',async()=>{
 const before={...request,title:'【在庫5】椅子'},after={...request,title:'【在庫3】椅子',inventoryVersion:'v2'};
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now),{job}=await store.ensure(before);
 assert.equal(desktopCausalSnapshotMatches(job,after),true);
 const rebased=await store.rebase(job,after);assert.equal(rebased.title,'【在庫3】椅子');assert.equal(rebased.id,job.id);
 const claimed=claimDesktopJob(newDesktopJob(before,now),'admin',now),started=startDesktopWrite(claimed,'admin',claimed.lease!,proof(claimed),now);
 assert.equal(desktopCausalSnapshotMatches(started,after),true);
 const done=finishDesktopJob(started,'admin',started.lease!,{...proof(started),observedEvidenceRef:'screenshots/after.png'},now);
 assert.equal(desktopCausalSnapshotMatches(done,after),true);
 assert.equal(desktopCausalSnapshotMatches(done,{...after,targetQuantity:2}),false);
 assert.equal(desktopCausalSnapshotMatches(done,{...after,title:'【在庫3】机'}),false);
});
test('finite lease-bound desktop problems keep uncertain state/lock and separate operational issues from code repair',async()=>{
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now),{job}=await store.ensure(request),claimed=await store.claim(job.id,'admin');
 db.rows.set('inventory:inventory-1',{updatedAt:'v1'});const started=await store.startWrite(claimed.id,'admin',claimed.lease!,proof(claimed),{table:'inventory',id:'inventory-1',version:'v1'});
 for(const [actor,lease,code] of [['other',started.lease,'DESKTOP_OPERATION_FAILED'],['admin','wrong','DESKTOP_OPERATION_FAILED'],['admin',started.lease,'UNTRUSTED_FREE_TEXT']])await assert.rejects(()=>store.recordIssue(started.id,actor!,lease!,code));
 assert.throws(()=>recordDesktopIssue(started,'admin',started.lease!,'DESKTOP_OPERATION_FAILED',now+16*60000),/LEASE_CHANGED/);
 const saved=await store.recordIssue(started.id,'admin',started.lease!,'REMOTE_FORMAT_CHANGED');assert.equal(saved.state,'WRITE_STARTED');assert.equal(saved.writeStartedAt,started.writeStartedAt);assert.equal(saved.lease,started.lease);assert.equal(db.rows.get('jobs:SALE_DESKTOP_REMOTE#mercari-1')?.state,'ACTIVE');
 assert.equal(desktopIssueDiagnostic('AUTH_REQUIRED'),'DESKTOP_AUTH_REQUIRED');assert.equal(desktopIssueDiagnostic('RATE_LIMITED'),'DESKTOP_RATE_LIMITED');assert.equal(desktopIssueDiagnostic('REMOTE_FORMAT_CHANGED'),'DESKTOP_REMOTE_FORM_CHANGED');
 assert.equal(expectedDesktopBoundaryError(Error('DESKTOP_EVIDENCE_MISMATCH')),true);assert.equal(expectedDesktopBoundaryError(Object.assign(Error('private'),{name:'ConditionalCheckFailedException'})),true);assert.equal(expectedDesktopBoundaryError(Object.assign(Error('private'),{name:'ProvisionedThroughputExceededException'})),false);
});
test('desktop COMPLETE atomically wakes only existing ACTIVE successors; legacy/versioned stale saves cannot postpone again',async()=>{
 for(const version of [undefined,'manual-v1']){
  const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now),{job}=await store.ensure(request),claimed=await store.claim(job.id,'admin');
  const automatic={id:'AUTO:'+request.candidateId,candidateId:request.candidateId,state:'SALE_AUTO_ACTIVE',version:'auto-v1',nextAt:now+DESKTOP_RETRY_MS};
  const manual:PostSaleJob={id:'EC_JOB:'+request.candidateId,candidateId:request.candidateId,state:'SALE_EC_ACTIVE',token:'token',actor:'admin',terms:false,createdAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),nextAt:now+DESKTOP_RETRY_MS,attempts:0,ttl:0,...(version?{version}:{})};
  db.rows.set('candidates:'+automatic.id,structuredClone(automatic));db.rows.set('candidates:'+manual.id,structuredClone(manual));
  const wakes=desktopSuccessorWakeWrites(request.candidateId,[automatic,manual,undefined,{...automatic,id:'unrelated'},{...automatic,state:'SALE_AUTO_ATTENTION'},{...manual,state:'SALE_EC_COMPLETE'}],'candidates',now);assert.equal(wakes.length,2);
  const e=proof(claimed);await store.finish(claimed.id,'admin',claimed.lease!,e,wakes);
  assert.equal((await store.get(job.id))?.state,'COMPLETE');assert.equal(db.rows.get('candidates:'+automatic.id)?.nextAt,0);assert.equal(db.rows.get('candidates:'+manual.id)?.nextAt,0);
  await assert.rejects(()=>db.send(new PutCommand(postSaleJobSaveRequest('candidates',manual,{token:manual.token,version:manual.version}))));assert.equal(db.rows.get('candidates:'+manual.id)?.nextAt,0);
  await assert.rejects(()=>db.send(new PutCommand({TableName:'candidates',Item:{...automatic,nextAt:now+DESKTOP_RETRY_MS},ConditionExpression:'#v=:v',ExpressionAttributeValues:{':v':'auto-v1'}})));assert.equal(db.rows.get('candidates:'+automatic.id)?.nextAt,0);
  const successor={...automatic,version:'successor',nextAt:now+100000};db.rows.set('candidates:'+automatic.id,successor);
  await store.finish(claimed.id,'admin',claimed.lease!,e,desktopSuccessorWakeWrites(request.candidateId,[successor],'candidates',now));assert.equal(db.rows.get('candidates:'+automatic.id)?.version,'successor');assert.equal(db.rows.get('candidates:'+automatic.id)?.nextAt,now+100000);
 }
});
test('concurrent successor change aborts completion atomically; stock remains reconcile-only until safe retry',async()=>{
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now),{job}=await store.ensure(request),claimed=await store.claim(job.id,'admin');db.rows.set('inventory:inventory-1',{updatedAt:'v1'});
 const started=await store.startWrite(claimed.id,'admin',claimed.lease!,proof(claimed),{table:'inventory',id:'inventory-1',version:'v1'}),automatic={id:'AUTO:'+request.candidateId,candidateId:request.candidateId,state:'SALE_AUTO_ACTIVE',version:'v1'};
 const stale=desktopSuccessorWakeWrites(request.candidateId,[automatic],'candidates',now);db.rows.set('candidates:'+automatic.id,{...automatic,version:'v2'});
 const e={...proof(started),observedEvidenceRef:'screenshots/after.png'};
 await assert.rejects(()=>store.finish(started.id,'admin',started.lease!,e,stale));assert.equal((await store.get(job.id))?.state,'WRITE_STARTED');assert.equal(db.rows.get('jobs:SALE_DESKTOP_REMOTE#mercari-1')?.state,'ACTIVE');
 await store.finish(started.id,'admin',started.lease!,e,desktopSuccessorWakeWrites(request.candidateId,[{...automatic,version:'v2'}],'candidates',now));assert.equal((await store.get(job.id))?.state,'COMPLETE');assert.equal(db.rows.get('candidates:'+automatic.id)?.nextAt,0);
});
test('fresh exact IDENTIFY comparison is reused for sale without another PC cycle; all identities/facts remain guarded',()=>{
 const c:SaleCandidate={id:request.candidateId,state:'PENDING',channel:'MERCARI',source:'GMAIL',name:'椅子',quantity:2,unitPrice:1000,orderId:'order-1',orderLineId:'line-1',identifierType:'ORDER',saleDate:'2026-11-21',receivedAt:new Date(now).toISOString(),createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),shipping:0,orderTotal:2000,payment:'',warnings:[],orderLineCount:1,senderAuthenticated:true,mercariOrderUrl:'https://mercari-shops.com/seller/shops/shop/orders/order-1',mercariShopId:'shop',externalListingId:'mercari-1',suggestedInventoryId:'inventory-1'};
 const j=claimDesktopJob(newDesktopJob({...request,purpose:'IDENTIFY_SALE',inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',externalId:'ORDER:order-1',imageKeys:[],title:c.name,orderUrl:c.mercariOrderUrl,shopId:c.mercariShopId,soldQuantity:2,unitPrice:1000,targetQuantity:undefined},now),'admin',now);
 const e={...proof(j),inventoryId:'inventory-1',inventoryVersion:'v1',externalId:'mercari-1',expectedImageKey:'inventory/chair.jpg',observedTitle:'椅子'},done=finishDesktopJob(j,'admin',j.lease!,e,now);
 c.mercariDesktopIdentity={jobId:done.id,snapshot:done.snapshot,inventoryVersion:'v1',evidenceRef:e.observedEvidenceRef,actor:'admin',verifiedAt:new Date(now).toISOString()};
 const inventory={id:'inventory-1',updatedAt:'v1',name:'【在庫5】椅子'};
 assert.equal(canReuseMercariIdentification(c,inventory,request.imageKeys,done,now+60000),true);
 for(const patch of [{senderAuthenticated:false},{quantity:3},{unitPrice:1001},{orderId:'other'},{orderLineId:'other'},{externalListingId:'other'},{suggestedInventoryId:'other'},{mercariOrderUrl:'https://other.test/'},{name:'机'}])assert.equal(canReuseMercariIdentification({...c,...patch},inventory,request.imageKeys,done,now+60000),false);
 assert.equal(canReuseMercariIdentification(c,{...inventory,updatedAt:'v2'},request.imageKeys,done,now+60000),false);assert.equal(canReuseMercariIdentification(c,inventory,['inventory/other.jpg'],done,now+60000),false);assert.equal(canReuseMercariIdentification(c,inventory,request.imageKeys,done,now+30*60000+1),false);
 assert.equal(canReuseMercariIdentification({...c,mercariDesktopIdentity:{...c.mercariDesktopIdentity,evidenceRef:'other'}},inventory,request.imageKeys,done,now+60000),false);
});
test('only exact completed stock/stop receipt can bypass plan timer; causal payment title/version changes require separate proof',()=>{
 const claimed=claimDesktopJob(newDesktopJob(request,now),'admin',now),done=finishDesktopJob(claimed,'admin',claimed.lease!,proof(claimed),now);
 assert.equal(completedDesktopStockReceipt(request,done),true);assert.equal(completedDesktopStockReceipt(request,claimed),false);
 for(const patch of [{externalId:'other'},{targetQuantity:2},{inventoryVersion:'v2'},{imageKeys:['inventory/other.jpg']}])assert.equal(completedDesktopStockReceipt({...request,...patch},done),false);
 const paid={...request,inventoryVersion:'v2',title:'【在庫3】椅子'};assert.equal(completedDesktopStockReceipt(paid,done),false);assert.equal(completedDesktopStockReceipt(paid,done,true),true);
 const stopRequest={...request,targetQuantity:0},stopClaim=claimDesktopJob(newDesktopJob(stopRequest,now),'admin',now),stop=finishDesktopJob(stopClaim,'admin',stopClaim.lease!,{...proof(stopClaim),observedQuantity:0,observedState:'STOPPED'},now);assert.equal(completedDesktopStockReceipt(stopRequest,stop),true);assert.equal(completedDesktopStockReceipt(stopRequest,{...stop,evidence:{...stop.evidence!,observedState:'ACTIVE'}}),false);
});
test('durable Mercari identification wakes the processor and continues through sale/EC once without a second PC cycle',async()=>{
 const db=memoryDb(),store=createDesktopJobStore(db,'jobs',()=>now),at=new Date(now).toISOString(),title='Magis Tom The Wild Bunch';
 const c:SaleCandidate={id:request.candidateId,state:'PENDING',channel:'MERCARI',source:'GMAIL',senderAuthenticated:true,name:title,quantity:1,unitPrice:1000,shipping:0,orderTotal:1000,orderId:'order-1',orderLineId:'line-1',identifierType:'ORDER',saleDate:'2026-11-21',receivedAt:at,createdAt:at,updatedAt:at,payment:'',warnings:[],orderLineCount:1,mercariOrderUrl:'https://mercari-shops.com/seller/shops/shop/orders/1',mercariShopId:'shop'};
 const inventory={id:'inventory-1',updatedAt:'v1',quantity:1,name:'【在庫1】Magis Tom - The Wild Bunch'},imageKeys=['inventory/chair.jpg'];
 db.rows.set('candidates:'+c.id,structuredClone(c));
 const desktopRequest:DesktopRequest={purpose:'IDENTIFY_SALE',candidateId:c.id,inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',externalId:'ORDER:'+c.orderId,title:c.name,imageKeys:[],orderId:c.orderId,orderLineId:c.orderLineId!,orderUrl:c.mercariOrderUrl,shopId:c.mercariShopId,soldQuantity:1,unitPrice:1000};
 const initial:AutomationJob={id:'AUTO:'+c.id,candidateId:c.id,state:'SALE_AUTO_ACTIVE',phase:'IDENTIFY',createdAt:at,updatedAt:at,receivedAt:at,version:'auto-v1',attempts:0};
 let saleWrites=0,ecWrites=0,prepared=0;
 const candidate=async()=>structuredClone(db.rows.get('candidates:'+c.id)) as SaleCandidate;
 const plan:PostSalePlan={id:c.id,candidateId:c.id,sourceId:inventory.id,sourceVersion:'v2',soldChannel:'MERCARI_SHOPS',remaining:0,actor:'worker',expiresAt:now+60000,rows:[{channel:'BASE',externalId:'base-1',operation:'STOP',state:'READY',message:''}],state:'REVIEW',token:'t',updatedAt:at};
 const p:AutomationPorts={now:()=>now,candidate,save:async j=>{db.rows.set('candidates:'+j.id,structuredClone(j));},decide:async value=>automaticSaleDecision(value,value.externalListingId?[inventory.id]:[],value.externalListingId?inventory:null,DEFAULT_FEES,new Date(now-1000).toISOString()),identify:async()=>{const {job}=await store.ensure(desktopRequest);return {status:'WAIT',nextAt:job.nextAt};},prepare:async value=>{prepared++;const saved=await store.get(value.mercariDesktopIdentity!.jobId);assert.equal(canReuseMercariIdentification(value,inventory,imageKeys,saved,now),true);return {status:'DONE'};},sell:async value=>{saleWrites++;const result={sourceId:inventory.id,soldId:inventory.id,remainingQuantity:0,soldQuantity:1,updatedAt:at};db.rows.set('candidates:'+c.id,{...value,state:'DONE',result,completedAt:at});return result;},review:async()=>plan,execute:async value=>{ecWrites++;return {...value,state:'COMPLETE',rows:value.rows.map(r=>({...r,state:'DONE'}))};}};
 await runAutomaticSale(initial,p);assert.equal(initial.reason,'MERCARI_DESKTOP_IDENTIFICATION');assert.equal(saleWrites,0);
 const claimed=await store.claim(desktopJobId(desktopRequest),'admin');
 const e={...proof(claimed),externalId:'mercari-1',inventoryId:inventory.id,inventoryVersion:inventory.updatedAt,expectedImageKey:imageKeys[0],observedTitle:title};
 assertDesktopIdentificationOrder(claimed,c);assertDesktopIdentificationInventory(c,inventory,imageKeys,e,e.externalId);
 const enriched={...c,externalListingId:e.externalId,suggestedInventoryId:inventory.id,mercariDesktopIdentity:{jobId:claimed.id,snapshot:claimed.snapshot,inventoryVersion:inventory.updatedAt,evidenceRef:e.observedEvidenceRef,actor:'admin',verifiedAt:at}};
 const wakes=desktopSuccessorWakeWrites(c.id,[db.rows.get('candidates:'+initial.id) as unknown as AutomationJob],'candidates',now);
 await store.finish(claimed.id,'admin',claimed.lease!,e,[{Put:{TableName:'candidates',Item:enriched,ConditionExpression:'#s=:p AND updatedAt=:v',ExpressionAttributeValues:{':p':'PENDING',':v':at}}},...wakes]);
 const awakened=structuredClone(db.rows.get('candidates:'+initial.id)) as unknown as AutomationJob;assert.equal(awakened.nextAt,0);
 await runAutomaticSale(awakened,p);await runAutomaticSale(awakened,p);
 assert.equal(awakened.state,'SALE_AUTO_COMPLETE');assert.deepEqual({saleWrites,ecWrites,prepared},{saleWrites:1,ecWrites:1,prepared:1});
 assert.equal([...db.rows.keys()].filter(k=>k.startsWith('jobs:SALE_DESKTOP#')).length,1);
});

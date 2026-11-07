const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists,waitUntilTableNotExists}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,PutCommand,GetCommand,UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const {SQSClient,CreateQueueCommand,DeleteQueueCommand}=require('@aws-sdk/client-sqs');
const region='us-west-2',prefix='bello-qa-inquiry-delivery-'+Date.now(),business=prefix+'-data';
const dynamo=new DynamoDBClient({region}),db=DynamoDBDocumentClient.from(dynamo),sqs=new SQSClient({region});
const created=[],passed=[];let queueUrl;const drafts=new Map(),conversations=new Map(),histories=new Map();let transmissions=0,outcome='ACCEPTED';
const pass=name=>{passed.push(name);console.log('PASS '+name);};
(async()=>{try{
 for(const [name,keys] of [[prefix,['pk','sk']],[business,['id']]]){
  await dynamo.send(new CreateTableCommand({TableName:name,BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:keys.map(AttributeName=>({AttributeName,AttributeType:'S'})),KeySchema:keys.map((AttributeName,i)=>({AttributeName,KeyType:i?'RANGE':'HASH'})),Tags:[{Key:'purpose',Value:'isolated-inquiry-delivery-acceptance'}]}));created.push(name);
  await waitUntilTableExists({client:dynamo,maxWaitTime:60,minDelay:2,maxDelay:5},{TableName:name});
 }
 queueUrl=(await sqs.send(new CreateQueueCommand({QueueName:prefix,Attributes:{SqsManagedSseEnabled:'true'}}))).QueueUrl;
 process.env.INQUIRY_TABLE=prefix;process.env.QUEUE_URL=queueUrl;process.env.INQUIRY_CUSTOMER_DELIVERY_ENABLED='true';
 const original=Module._load;Module._load=function(request){
  if(request==='server-only')return {};
  if(request==='@/lib/messaging/service')return {getConversation:async id=>conversations.get(id),listMessages:async id=>histories.get(id)};
  if(request==='@/lib/inquiry/draftStore')return {getReplyDraft:async id=>drafts.get(id)};
  if(request==='@/lib/amplify/directData')return {directTableName:()=>business};
  if(request==='@/lib/amplify/dataClient')return {runWithDirectData:fn=>fn()};
  if(request==='./customerTransport')return {sendCustomerMessage:async(target,body,key,check)=>{assert(await check());transmissions++;await new Promise(r=>setTimeout(r,50));return {status:outcome,receipt:outcome==='ACCEPTED'?'qa-receipt-'+transmissions:undefined};}};
  return original.apply(this,arguments);
 };require('tsx/cjs');
 const policy=require('../../lib/inquiry/runtime/policy.ts'),jobs=require('../../lib/inquiry/runtime/deliveryJobs.ts'),store=require('../../lib/inquiry/runtime/store.ts');
 const evaluation={version:'qa',reviewer:'qa-only',cases:50,wrongProduct:0,wrongRecipient:0,duplicates:0,ungroundedPromises:0,factCorrectRate:1,identificationRate:1};
 await db.send(new PutCommand({TableName:prefix,Item:{pk:'CONFIG',sk:'STATE',enabled:true,delivery:{mode:'REVIEW',approvedIntents:['general'],evaluation}}}));
 let serial=0;
 async function fixture(){
  const n=++serial,pk='CONV#'+n.toString(16).padStart(64,'0'),cid='qa-conversation-'+n,mid='qa-message-'+n,did='qa-draft-'+n,now=new Date().toISOString(),older=new Date(Date.now()-60000).toISOString();
  const c={id:cid,channel:'LINE',externalCustomerId:'U'+'a'.repeat(32),lastIncomingAt:older};const messages=[{id:mid,direction:'INBOUND',body:'テスト専用',deliveryStatus:'RECEIVED',createdAt:older,updatedAt:older}];
  conversations.set(cid,c);histories.set(cid,messages);
  const draft={id:did,conversationId:cid,sourceMessageId:mid,updatedAt:now,draftText:'外部送信しない試験本文',status:'READY',intents:['general'],unresolvedFacts:[],evidence:{runtimeProof:{conversationStamp:policy.conversationStamp(c,messages),generatedAt:now},knowledgeDocuments:[]}};drafts.set(did,draft);
  await db.send(new PutCommand({TableName:prefix,Item:{pk,sk:'STATE',version:1,processedVersion:1,conversationId:cid,sourceEventSk:'EVENT#qa'}}));
  await db.send(new PutCommand({TableName:prefix,Item:{pk,sk:'EVENT#qa',payload:{channel:'LINE',account:'U'+'b'.repeat(32),event:{source:{userId:c.externalCustomerId}}}}}));
  await db.send(new PutCommand({TableName:business,Item:{...c,createdAt:older,updatedAt:older}}));
  return {pk,cid,mid,did,now,draft,messages};
 }
 const a=await fixture();const queued=await Promise.all(Array.from({length:5},()=>jobs.enqueueCustomerDelivery(a.pk,a.did,a.now,'qa-admin')));assert.equal(new Set(queued.map(j=>j.jobId)).size,1);pass('5並列送信予約は同じ1件');
 const id=queued[0].jobId;await Promise.allSettled(Array.from({length:5},()=>jobs.runCustomerDelivery(id)));assert.equal(transmissions,1);assert.equal((await store.getRuntimeRecord(id)).status,'ACCEPTED');
 assert.equal((await db.send(new GetCommand({TableName:business,Key:{id}}))).Item.body,a.draft.draftText);pass('5並列処理でも外部呼出し相当1回・送信記録1件');
 await jobs.runCustomerDelivery(id);assert.equal(transmissions,1);pass('完了済み予約は再実行しない');
 const b=await fixture(),bjob=await jobs.enqueueCustomerDelivery(b.pk,b.did,b.now,'qa-admin');
 b.draft.updatedAt=new Date(Date.now()+1).toISOString();b.draft.id=b.did+'-edited';drafts.set(b.draft.id,{...b.draft});
 const bjob2=await jobs.enqueueCustomerDelivery(b.pk,b.draft.id,b.draft.updatedAt,'qa-admin');
 // Keep both drafts unchanged and fresh to test the per-inbound reply reservation.
 drafts.set(b.did,{...b.draft,id:b.did,updatedAt:b.now});
 await Promise.all([jobs.runCustomerDelivery(bjob.jobId),jobs.runCustomerDelivery(bjob2.jobId)]);
 assert.equal(transmissions,2);assert.deepEqual([...(await Promise.all([bjob,bjob2].map(async j=>(await store.getRuntimeRecord(j.jobId)).status)))].sort(),['ACCEPTED','CANCELLED']);pass('同じ問い合わせの別下書きも二重送信しない');
 const c=await fixture(),cj=await jobs.enqueueCustomerDelivery(c.pk,c.did,c.now,'qa-admin');histories.get(c.cid).push({id:'new',direction:'INBOUND',body:'追記',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deliveryStatus:'RECEIVED'});await jobs.runCustomerDelivery(cj.jobId);assert.equal((await store.getRuntimeRecord(cj.jobId)).status,'CANCELLED');assert.equal(transmissions,2);pass('処理中の追記は送信を取り消す');
 const d=await fixture();d.draft.resolvedInventoryId='qa-stock';d.draft.evidence.inventoryVersion={id:'qa-stock',updatedAt:d.now};await db.send(new PutCommand({TableName:business,Item:{id:'qa-stock',updatedAt:d.now}}));const dj=await jobs.enqueueCustomerDelivery(d.pk,d.did,d.now,'qa-admin');await db.send(new PutCommand({TableName:business,Item:{id:'qa-stock',updatedAt:'changed'}}));await jobs.runCustomerDelivery(dj.jobId);assert.equal((await store.getRuntimeRecord(dj.jobId)).status,'CANCELLED');assert.equal(transmissions,2);pass('在庫・価格の版変更を検出して送信しない');
 const e=await fixture();outcome='UNKNOWN';const ej=await jobs.enqueueCustomerDelivery(e.pk,e.did,e.now,'qa-admin');await jobs.runCustomerDelivery(ej.jobId);await jobs.runCustomerDelivery(ej.jobId);assert.equal(transmissions,3);assert.equal((await store.getRuntimeRecord(ej.jobId)).status,'UNKNOWN');pass('送信結果不明を成功扱い・自動再送しない');
 const f=await fixture(),fj=await jobs.enqueueCustomerDelivery(f.pk,f.did,f.now,'qa-admin');await db.send(new UpdateCommand({TableName:prefix,Key:{pk:fj.jobId,sk:'STATE'},UpdateExpression:'SET #s=:s,leaseUntil=:until',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':'SENDING',':until':Date.now()-1}}));await jobs.runCustomerDelivery(fj.jobId);assert.equal((await store.getRuntimeRecord(fj.jobId)).status,'UNKNOWN');assert.equal(transmissions,3);pass('送信直後のクラッシュは再送せず確認待ち');
 const g=await fixture();g.draft.evidence.runtimeProof.generatedAt='invalid';await assert.rejects(()=>jobs.enqueueCustomerDelivery(g.pk,g.did,g.now,'qa-admin'),/STALE_DRAFT/);pass('壊れた生成時刻を新しい下書きとみなさない');
 }finally{
  if(queueUrl){assert(queueUrl.endsWith('/'+prefix));await sqs.send(new DeleteQueueCommand({QueueUrl:queueUrl}));}
  for(const name of created){assert(name.startsWith(prefix));await dynamo.send(new DeleteTableCommand({TableName:name}));await waitUntilTableNotExists({client:dynamo,maxWaitTime:60,minDelay:2,maxDelay:5},{TableName:name});}
  fs.writeFileSync('artifacts/whole-instruction-20261107/inquiry-delivery-aws-tests.json',JSON.stringify({at:new Date().toISOString(),environment:'isolated real DynamoDB/SQS; external delivery mocked',passed,customerTransmissions:0,cleanupConfirmed:true},null,2));
 }
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

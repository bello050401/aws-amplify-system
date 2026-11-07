// Isolated real-AWS acceptance test. Never uses production business tables or sends messages.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const {DynamoDBClient,CreateTableCommand,DeleteTableCommand,DescribeTableCommand,waitUntilTableExists}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,GetCommand,UpdateCommand,ScanCommand}=require('@aws-sdk/lib-dynamodb');
const {SQSClient,CreateQueueCommand,DeleteQueueCommand}=require('@aws-sdk/client-sqs');
const region='us-west-2',prefix='bello-qa-inquiry-'+Date.now(),dynamo=new DynamoDBClient({region}),db=DynamoDBDocumentClient.from(dynamo),sqs=new SQSClient({region});
const tables=[],passed=[];let queueUrl;const config={region,table:prefix+'-inbox',queueUrl:'',secretArn:'qa-unused'};
function pass(name){passed.push(name);console.log('PASS '+name);}
async function create(name,range=false){assert(name.startsWith(prefix));await dynamo.send(new CreateTableCommand({TableName:name,BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:range?[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]:[{AttributeName:'id',AttributeType:'S'}],KeySchema:range?[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]:[{AttributeName:'id',KeyType:'HASH'}],Tags:[{Key:'purpose',Value:'isolated-inquiry-acceptance'}]}));tables.push(name);await waitUntilTableExists({client:dynamo,maxWaitTime:60,minDelay:2,maxDelay:5},{TableName:name});}
(async()=>{
 try{
  await create(config.table,true);await create(prefix+'-messages');await create(prefix+'-conversations');
  queueUrl=(await sqs.send(new CreateQueueCommand({QueueName:prefix,Attributes:{SqsManagedSseEnabled:'true'}}))).QueueUrl;config.queueUrl=queueUrl;
  const outputs=require('../../amplify_outputs.json'),original=Module._load;
  Module._load=function(request,parent,isMain){if(request==='server-only')return {};if(request.includes('amplify_outputs.json')&&parent?.filename.includes('inquiry'))return {...outputs,custom:{...outputs.custom,inquiryRuntime:config}};return original.apply(this,arguments);};
  require('tsx/cjs');
  const store=require('../../lib/inquiry/runtime/store.ts'),{recordIncomingWebhookMessageWith}=require('../../lib/messaging/webhookStore.ts');
  const payload={channel:'LINE',account:'qa-account',event:{type:'message',timestamp:Date.now(),webhookEventId:'qa1',source:{type:'user',userId:'qa-user'},message:{id:'qa1',type:'text',text:'synthetic test only'}}};
  const keys=await Promise.all(Array.from({length:10},()=>store.enqueueInquiry('LINE','qa-account','qa-user','qa-event-1',payload)));assert.equal(new Set(keys).size,1);const pk=keys[0];assert.equal((await store.stateFor(pk)).version,1);pass('LINEの同一イベント10並列受信を1件に保存');
  assert('retrySeconds' in await store.claimInquiry(pk));pass('待ち合わせ時間より前は処理しない');
  await db.send(new UpdateCommand({TableName:config.table,Key:{pk,sk:'STATE'},UpdateExpression:'SET dueAt=:now',ExpressionAttributeValues:{':now':0}}));
  const claims=await Promise.all(Array.from({length:8},()=>store.claimInquiry(pk))),claim=claims.find(c=>c?.owner);assert.equal(claims.filter(c=>c?.owner).length,1);pass('8並列の処理開始で1ワーカーだけ取得');
  assert(await store.stillCurrent(claim.state,claim.owner));
  await store.enqueueInquiry('LINE','qa-account','qa-user','qa-event-2',{...payload,event:{...payload.event,message:{id:'qa2',type:'text',text:'追加'}}});assert(!await store.stillCurrent(claim.state,claim.owner));pass('処理途中の追記で古い解析結果を失効');
  await store.releaseInquiry(claim.state,claim.owner);
  await db.send(new UpdateCommand({TableName:config.table,Key:{pk,sk:'STATE'},UpdateExpression:'SET dueAt=:now',ExpressionAttributeValues:{':now':0}}));
  const next=await store.claimInquiry(pk);assert(next.owner);assert.equal((await store.eventsFor(next.state)).length,2);
  await db.send(new UpdateCommand({TableName:config.table,Key:{pk,sk:'STATE'},UpdateExpression:'SET #mode=:mode',ExpressionAttributeNames:{'#mode':'mode'},ExpressionAttributeValues:{':mode':'STAFF'}}));assert(!await store.stillCurrent(next.state,next.owner));pass('社員対応中は解析結果の公開を拒否');
  await store.finishInquiry(next.state,next.owner,'STAFF_CONFIRMATION','synthetic');assert.equal(await store.claimInquiry(pk),null);pass('完了イベントを再実行しない');
  const deps={send:c=>db.send(c),conversationTable:prefix+'-conversations',messageTable:prefix+'-messages',now:()=>new Date().toISOString(),newId:()=>crypto.randomUUID()};
  const message={channel:'LINE',externalAccountId:'qa-account',externalConversationId:'thread',externalCustomerId:'qa-user',externalMessageId:'qa-message',body:'synthetic only',externalSentAt:'2026-11-07T10:00:00.000Z'};
  const saved=await Promise.all(Array.from({length:8},()=>recordIncomingWebhookMessageWith(deps,message)));assert.equal(new Set(saved.map(s=>s.messageId)).size,1);
  const cid=saved[0].conversationId;let conversation=(await db.send(new GetCommand({TableName:deps.conversationTable,Key:{id:cid},ConsistentRead:true}))).Item;assert.equal(conversation.unreadCount,1);pass('メッセージと会話を原子的に保存・未読数は1');
  const other=await recordIncomingWebhookMessageWith(deps,{...message,externalAccountId:'other',externalMessageId:'qa-message-other'});assert.notEqual(other.conversationId,cid);pass('同じ顧客でも異なる公式アカウントは別会話');
  await db.send(new UpdateCommand({TableName:deps.conversationTable,Key:{id:cid},UpdateExpression:'SET lastOutgoingAt=:t,lastMessageAt=:t,lastMessagePreview=:p',ExpressionAttributeValues:{':t':'2026-11-07T12:00:00.000Z',':p':'社員返信'}}));
  await recordIncomingWebhookMessageWith(deps,{...message,externalMessageId:'qa-delayed',externalSentAt:'2026-11-07T09:00:00.000Z'});
  conversation=(await db.send(new GetCommand({TableName:deps.conversationTable,Key:{id:cid},ConsistentRead:true}))).Item;assert.equal(conversation.lastMessagePreview,'社員返信');assert.equal(conversation.needsReply,false);pass('遅れて届いた旧受信が社員の新しい返信状態を巻き戻さない');
  const fixed={...deps,now:()=> '2026-11-07T13:00:00.000Z'};
  await Promise.all(Array.from({length:4},(_,i)=>recordIncomingWebhookMessageWith(fixed,{...message,externalMessageId:'qa-distinct-'+i,externalSentAt:'2026-11-07T13:00:00.000Z'})));
  conversation=(await db.send(new GetCommand({TableName:deps.conversationTable,Key:{id:cid},ConsistentRead:true}))).Item;assert.equal(conversation.unreadCount,6);pass('同一ミリ秒の異なる4件の並列受信でも未読件数を失わない');
  const messages=(await db.send(new ScanCommand({TableName:deps.messageTable,ConsistentRead:true}))).Items;assert.equal(messages.length,7);pass('テストメッセージ数・会話関連の整合性');
 }finally{
  if(queueUrl){assert(queueUrl.endsWith('/'+prefix));await sqs.send(new DeleteQueueCommand({QueueUrl:queueUrl}));}
  for(const name of tables){assert(name.startsWith(prefix+'-'));await dynamo.send(new DeleteTableCommand({TableName:name}));}
  fs.writeFileSync('artifacts/whole-instruction-20261107/inquiry-aws-tests.json',JSON.stringify({at:new Date().toISOString(),environment:'isolated real AWS',passed,tables,queue:queueUrl,cleanupRequested:true},null,2));
 }
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

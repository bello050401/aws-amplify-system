const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists,waitUntilTableNotExists}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,PutCommand,UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const {SQSClient,CreateQueueCommand,DeleteQueueCommand}=require('@aws-sdk/client-sqs');
const region='us-west-2',prefix='bello-qa-inquiry-read-'+Date.now(),dynamo=new DynamoDBClient({region}),db=DynamoDBDocumentClient.from(dynamo),sqs=new SQSClient({region});
const passed=[];let queueUrl,created=false;const config={region,table:prefix,queueUrl:''};
const pass=name=>{passed.push(name);console.log('PASS '+name);};
(async()=>{try{
 await dynamo.send(new CreateTableCommand({TableName:prefix,BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'},{AttributeName:'kind',AttributeType:'S'},{AttributeName:'lastAt',AttributeType:'N'}],KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],GlobalSecondaryIndexes:[{IndexName:'recent',KeySchema:[{AttributeName:'kind',KeyType:'HASH'},{AttributeName:'lastAt',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}],Tags:[{Key:'purpose',Value:'isolated-inquiry-read-acceptance'}]}));created=true;
 await waitUntilTableExists({client:dynamo,maxWaitTime:60,minDelay:2,maxDelay:5},{TableName:prefix});
 queueUrl=(await sqs.send(new CreateQueueCommand({QueueName:prefix,Attributes:{SqsManagedSseEnabled:'true'}}))).QueueUrl;config.queueUrl=queueUrl;
 process.env.INQUIRY_TABLE=prefix;process.env.QUEUE_URL=queueUrl;
 const original=Module._load;Module._load=function(request){if(request==='server-only')return {};return original.apply(this,arguments);};require('tsx/cjs');
 const store=require('../../lib/inquiry/runtime/store.ts'),jobs=require('../../lib/inquiry/runtime/readJobs.ts');
 await db.send(new PutCommand({TableName:prefix,Item:{pk:'CONFIG',sk:'STATE',enabled:true,mercariShopId:'qa-shop'}}));
 const pk='CONV#'+'a'.repeat(64),state={pk,sk:'STATE',version:1,processedVersion:1,firstAt:Date.now(),dueAt:0,lastAt:Date.now()};
 await db.send(new PutCommand({TableName:prefix,Item:state}));
 const url='https://mercari-shops.com/seller/shops/qa-shop/inquiries/qa-inquiry';
 const requests=await Promise.all(Array.from({length:5},()=>jobs.requestInquiryRead(state,'qa-message',url)));assert.equal(new Set(requests.map(r=>r.pk)).size,1);pass('同じ受信版の5並列依頼を1件に保存');
 let claims=[];for(let n=0;n<6&&!claims.some(Boolean);n++){claims=await Promise.all(Array.from({length:5},()=>jobs.claimInquiryRead('qa-admin')));if(!claims.some(Boolean))await new Promise(r=>setTimeout(r,500));}
 assert.equal(claims.filter(Boolean).length,1);const claim=claims.find(Boolean);pass('5並列でもアカウント・ジョブの操作権は1つ');
 const snapshot={shopId:'qa-shop',inquiryId:'qa-inquiry',url,capturedAt:new Date().toISOString(),complete:true,productId:'qa-product',messages:[{speaker:'BUYER',body:'テスト用の幅確認',sentAt:new Date(Date.now()-60000).toISOString()}]};
 await assert.rejects(()=>jobs.finishInquiryRead('other',claim.jobId,claim.leaseId,snapshot),/READ_OWNER_REQUIRED/);pass('別の管理者セッションから結果を横取りできない');
 await assert.rejects(()=>jobs.finishInquiryRead('qa-admin',claim.jobId,claim.leaseId,{...snapshot,inquiryId:'other'}),/READ_IDENTITY_MISMATCH/);pass('別会話の本文は保存しない');
 assert.equal((await jobs.finishInquiryRead('qa-admin',claim.jobId,claim.leaseId,snapshot)).status,'DONE');
 assert.equal((await store.stateFor(pk)).processedVersion,0);assert.equal((await store.getRuntimeRecord(claim.jobId)).result.messages[0].body,snapshot.messages[0].body);pass('全文保存と下書き再処理予約が一体で完了');
 assert.equal((await jobs.finishInquiryRead('qa-admin',claim.jobId,claim.leaseId,snapshot)).status,'DONE');pass('完了通知の再送で二重取得・二重保存しない');
 const state2={...state,version:2,processedVersion:2};await db.send(new PutCommand({TableName:prefix,Item:state2}));await jobs.requestInquiryRead(state2,'qa-message2',url);
 let second;for(let n=0;n<6&&!second;n++){second=await jobs.claimInquiryRead('qa-admin');if(!second)await new Promise(r=>setTimeout(r,500));}assert(second);
 await db.send(new UpdateCommand({TableName:prefix,Key:{pk,sk:'STATE'},UpdateExpression:'SET #v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':3}}));
 assert.equal((await jobs.finishInquiryRead('qa-admin',second.jobId,second.leaseId,snapshot)).status,'STALE');assert.equal((await store.stateFor(pk)).version,3);pass('閲覧中の新着を古い取得結果で巻き戻さない');
 const state3={...state,version:3,processedVersion:3};await jobs.requestInquiryRead(state3,'qa-message3',url);let third;for(let n=0;n<6&&!third;n++){third=await jobs.claimInquiryRead('qa-admin');if(!third)await new Promise(r=>setTimeout(r,500));}assert(third);
 assert.equal((await jobs.finishInquiryRead('qa-admin',third.jobId,third.leaseId,null,'AUTH_REQUIRED')).status,'BLOCKED');assert.equal((await store.stateFor(pk)).result,'TECHNICAL_BLOCK');pass('認証切れは成功扱いにせず復旧待ちとして保存');
 }finally{
  if(queueUrl){assert(queueUrl.endsWith('/'+prefix));await sqs.send(new DeleteQueueCommand({QueueUrl:queueUrl}));}
  if(created){assert(prefix.startsWith('bello-qa-inquiry-read-'));await dynamo.send(new DeleteTableCommand({TableName:prefix}));await waitUntilTableNotExists({client:dynamo,maxWaitTime:60,minDelay:2,maxDelay:5},{TableName:prefix});}
  fs.writeFileSync('artifacts/whole-instruction-20261107/inquiry-read-aws-tests.json',JSON.stringify({at:new Date().toISOString(),environment:'isolated real AWS',passed,cleanupConfirmed:true},null,2));
 }
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

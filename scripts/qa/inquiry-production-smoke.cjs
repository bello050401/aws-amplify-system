const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {DynamoDBClient}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,PutCommand,GetCommand,DeleteCommand}=require('@aws-sdk/lib-dynamodb');
const {LambdaClient,InvokeCommand,GetFunctionConfigurationCommand}=require('@aws-sdk/client-lambda');
const region='us-west-2',fn='amplify-d4hkkg7dty2du-claudeinvento-Worker11F36D0F-2WWHmekQi8Jm';
const lambda=new LambdaClient({region}),db=DynamoDBDocumentClient.from(new DynamoDBClient({region}));
(async()=>{
 const {Environment}=await lambda.send(new GetFunctionConfigurationCommand({FunctionName:fn}));const env=Environment.Variables,table=env.INQUIRY_TABLE,suffix=env.CONVERSATION_TABLE_NAME.slice('Conversation-'.length);
 const local=process.argv.includes('--local');let localRun;
 if(local){
  Object.assign(process.env,env);const path=require('node:path');
  await require('esbuild').build({stdin:{contents:'export { runInquiry } from "./lib/inquiry/runtime/worker"',resolveDir:process.cwd()},outfile:'artifacts/whole-instruction-20261107/worker-local.cjs',bundle:true,platform:'node',target:'node22',format:'cjs',packages:'external',alias:{'server-only':path.resolve('amplify/functions/inquiry-runtime/server-only.ts'),'@/lib/amplify/dataClient':path.resolve('amplify/functions/inquiry-runtime/dataClient.ts'),'@/lib/inquiry/runtime/config':path.resolve('amplify/functions/inquiry-runtime/config.ts'),'@/lib/inventory/mutationSession':path.resolve('amplify/functions/inquiry-runtime/webBoundary.ts'),'@/lib/amplify/serverUtils':path.resolve('amplify/functions/inquiry-runtime/webBoundary.ts')}});
  localRun=require('../../artifacts/whole-instruction-20261107/worker-local.cjs').runInquiry;
 }
 assert(table.includes('InquiryRuntime'));const tag='qa-inquiry-release-'+crypto.randomUUID(),cid=tag,mid=tag+'-message',pk='CONV#'+crypto.createHash('sha256').update(tag).digest('hex'),sk='EVENT#'+crypto.createHash('sha256').update(mid).digest('hex'),now=Date.now(),iso=new Date(now).toISOString();
 const cleanup=[];const put=async(TableName,Item)=>{await db.send(new PutCommand({TableName,Item,ConditionExpression:'attribute_not_exists('+('id'in Item?'id':'pk')+')'}));cleanup.push([TableName,'id'in Item?{id:Item.id}:{pk:Item.pk,sk:Item.sk}]);};
 const config=(await db.send(new GetCommand({TableName:table,Key:{pk:'CONFIG',sk:'STATE'},ConsistentRead:true}))).Item;
 fs.writeFileSync('artifacts/whole-instruction-20261107/runtime-config-before-private.json',JSON.stringify(config??null));
 const report={at:iso,execution:local?'local bundle with production test records':'published Lambda',productionFunction:fn,customerMessagesSent:0,passed:[],cleanup:false};
 try{
  await db.send(new PutCommand({TableName:table,Item:{...config,pk:'CONFIG',sk:'STATE',enabled:true,notifyStaff:false}}));
  await put('Conversation-'+suffix,{id:cid,channel:'MERCARI_SHOPS',externalCustomerId:tag,externalAccountId:tag,externalConversationId:tag,customerDisplayName:'公開後の内部動作確認',status:'OPEN',workflowStatus:'NEW',needsReply:true,lastIncomingAt:iso,lastMessageAt:iso,lastMessagePreview:'検証用。顧客への送信なし。',unreadCount:1,createdAt:iso,updatedAt:iso});
  await put('Message-'+suffix,{id:mid,conversationId:cid,channel:'MERCARI_SHOPS',externalMessageId:tag,direction:'INBOUND',senderKind:'CUSTOMER',body:'検証用。顧客への送信なし。',deliveryStatus:'RECEIVED',externalSentAt:iso,createdAt:iso,updatedAt:iso});
  await put(table,{pk,sk,version:1,receivedAt:now,ttl:Math.ceil(now/1000)+3600,payload:{channel:'MERCARI_SHOPS',params:{conversationId:cid,sourceMessageId:mid,who:null,skipGeneration:true,skipReason:'公開後の内部動作確認。本文欠落時は推測生成しません。'}}});
  await put(table,{pk,sk:'STATE',version:1,firstAt:now,lastAt:now,dueAt:0,lastEventSk:sk,kind:'INBOX',channel:'MERCARI_SHOPS',mode:'DRAFT'});
  const request={Records:[{messageId:tag,body:JSON.stringify({pk}),receiptHandle:'synthetic-never-retried'}]};
  for(let n=0;n<2;n++){
   if(local){await localRun(pk);}else{
    const response=await lambda.send(new InvokeCommand({FunctionName:fn,Payload:Buffer.from(JSON.stringify(request))}));
    assert(!response.FunctionError);const result=JSON.parse(Buffer.from(response.Payload).toString());assert.deepEqual(result.batchItemFailures,[]);
   }
   const state=(await db.send(new GetCommand({TableName:table,Key:{pk,sk:'STATE'},ConsistentRead:true}))).Item;
   assert.equal(state.processedVersion,1);assert.equal(state.result,'TECHNICAL_BLOCK');assert.equal(state.conversationId,cid);report.passed.push(n?'同じ処理を再実行しても二重処理しない':'公開Lambdaが会話・本文・設定を読み、取得不足を技術的確認待ちとして保存');
  }
 }finally{
  if(config)await db.send(new PutCommand({TableName:table,Item:config}));else await db.send(new DeleteCommand({TableName:table,Key:{pk:'CONFIG',sk:'STATE'}}));
  for(const [TableName,Key]of cleanup.reverse()){assert((Key.id??Key.pk).includes(tag)||Key.pk===pk);await db.send(new DeleteCommand({TableName,Key}));}
  report.cleanup=true;fs.writeFileSync('artifacts/whole-instruction-20261107/inquiry-production-smoke.json',JSON.stringify(report,null,2));
 }
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

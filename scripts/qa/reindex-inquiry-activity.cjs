// One-time inbox ordering repair. Does not edit messages, drafts, stock, or send anything.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {LambdaClient,GetFunctionConfigurationCommand}=require('@aws-sdk/client-lambda');
const {DynamoDBClient}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,QueryCommand,BatchGetCommand,UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const dir='artifacts/whole-instruction-20261107',apply=process.argv.includes('--apply');
(async()=>{
 const {Environment}=await new LambdaClient({region:'us-west-2'}).send(new GetFunctionConfigurationCommand({FunctionName:'amplify-d4hkkg7dty2du-claudeinvento-Worker11F36D0F-2WWHmekQi8Jm'}));
 const table=Environment.Variables.INQUIRY_TABLE,ct=Environment.Variables.CONVERSATION_TABLE_NAME;
 assert(table.includes('InquiryRuntime')&&ct.startsWith('Conversation-'));
 const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));let key,states=[];
 do{const p=await db.send(new QueryCommand({TableName:table,IndexName:'recent',KeyConditionExpression:'kind=:k',ExpressionAttributeValues:{':k':'INBOX'},ExclusiveStartKey:key,Limit:100}));states.push(...p.Items);key=p.LastEvaluatedKey;assert(states.length<=10000);}while(key);
 const ids=[...new Set(states.map(s=>s.conversationId).filter(Boolean))],map=new Map();
 for(let i=0;i<ids.length;i+=100){let pending={[ct]:{Keys:ids.slice(i,i+100).map(id=>({id})),ProjectionExpression:'id,lastIncomingAt,lastOutgoingAt,lastMessageAt',ConsistentRead:true}};
  for(let n=0;Object.keys(pending).length&&n<4;n++){const p=await db.send(new BatchGetCommand({RequestItems:pending}));for(const row of p.Responses?.[ct]??[])map.set(row.id,row);pending=p.UnprocessedKeys??{};}assert.equal(Object.keys(pending).length,0,'Incomplete batch read');
 }
 const changes=[],now=Date.now();
 for(const state of states){if(state.activityVersion===1)continue;const c=map.get(state.conversationId);if(!c)continue;const dates=[c.lastIncomingAt,c.lastOutgoingAt,c.lastMessageAt].map(Date.parse).filter(v=>Number.isFinite(v)&&v>0&&v<=now);if(!dates.length)continue;changes.push({pk:state.pk,sk:'STATE',version:state.version,conversationId:state.conversationId,oldLastAt:state.lastAt,newLastAt:Math.max(...dates)});}
 fs.writeFileSync(`${dir}/activity-reindex-${apply?'apply':'preview'}-private.json`,JSON.stringify({at:new Date().toISOString(),table,changes},null,2));
 const report={at:new Date().toISOString(),apply,examined:states.length,planned:changes.length,updated:0,concurrentSkipped:0};
 if(apply)for(const c of changes){try{await db.send(new UpdateCommand({TableName:table,Key:{pk:c.pk,sk:c.sk},ConditionExpression:'#v=:v AND lastAt=:old AND conversationId=:cid AND attribute_not_exists(activityVersion)',UpdateExpression:'SET lastAt=:new,activityVersion=:one',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':c.version,':old':c.oldLastAt,':cid':c.conversationId,':new':c.newLastAt,':one':1}}));report.updated++;}catch(e){if(e.name!=='ConditionalCheckFailedException')throw e;report.concurrentSkipped++;}}
 fs.writeFileSync(`${dir}/activity-reindex-summary.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

// Owner-approved monthly trial: 1,000 JPY. Preserve all usage and reservations.
const fs=require('node:fs');
const {DynamoDBClient}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,GetCommand,UpdateCommand}=require('@aws-sdk/lib-dynamodb');
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));
const table='AIBudgetLedger-j6up24p7lnczdmklzjdt3vrp4y-NONE';
(async()=>{
 const month=new Date(Date.now()+9*3600000).toISOString().slice(0,7);
 const key={month};const before=(await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}))).Item;
 if(!before||![3000000,10000000].includes(before.cap))throw Error('Unexpected ledger ceiling');
 if(before.spent+before.reserved+before.remaining!==before.cap)throw Error('Ledger does not balance');
 fs.mkdirSync('artifacts/customer-ai-20261108',{recursive:true});
 if(before.cap===3000000&&process.argv.includes('--apply')){
   fs.writeFileSync('artifacts/customer-ai-20261108/budget-trial-before.json',JSON.stringify(before,null,2),{flag:'wx'});
   await db.send(new UpdateCommand({TableName:table,Key:key,ConditionExpression:'cap=:old',
     UpdateExpression:'SET cap=:cap, remaining=remaining+:extra, updatedAt=:now',
     ExpressionAttributeValues:{':old':3000000,':cap':10000000,':extra':7000000,':now':new Date().toISOString()}}));
 }
 const after=(await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}))).Item;
 if(after.spent+after.reserved+after.remaining!==after.cap)throw Error('Ledger verification failed');
 const result={at:new Date().toISOString(),month,beforeCapJPY:before.cap/10000,capJPY:after.cap/10000,spentJPY:after.spent/10000,reservedJPY:after.reserved/10000,remainingJPY:after.remaining/10000,automaticIncrease:false};
 fs.writeFileSync('artifacts/customer-ai-20261108/budget-trial-result.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1});

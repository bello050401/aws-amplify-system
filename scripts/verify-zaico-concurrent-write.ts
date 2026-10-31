import assert from 'node:assert/strict';
import {GetCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {InventorySaveError} from '../lib/inventory/conditionalUpdate';
import type {UpdateInventoryInput} from '../lib/inventory/zaicoSyncPorts';
async function main(){
 process.env.INVENTORY_TABLE_NAME='Inventory-QA';
 const {createLambdaSyncPort,ddb}=await import('../amplify/functions/zaico-sync-worker/lambdaSyncPort');
 const originalSend=ddb.send,oldVersion='2026-10-17T00:00:00.000Z';
 let record:Record<string,any>={id:'fixture',updatedAt:oldVersion,quantity:10,categoryIds:[]};
 let writes=0,calls=0,loseReply=false;
 ddb.send=(async(command:unknown)=>{
  calls++;
  if(command instanceof GetCommand){assert.equal(command.input.TableName,'Inventory-QA');return{Item:structuredClone(record)};}
  assert.ok(command instanceof TransactWriteCommand);
  const update=command.input.TransactItems![0].Update!;
  assert.equal(update.TableName,'Inventory-QA');
  assert.match(update.ConditionExpression!,/updatedAt = :version/);
  assert.match(update.ConditionExpression!,/attribute_not_exists\(outboundBatchId\)/);
  if(record.updatedAt!==update.ExpressionAttributeValues![':version'])throw Object.assign(Error('rejected'),{name:'TransactionCanceledException'});
  for(const [alias,key] of Object.entries(update.ExpressionAttributeNames!)){
   const value=':v'+alias.slice(2);
   if(value in update.ExpressionAttributeValues!)record[key]=update.ExpressionAttributeValues![value];else delete record[key];
  }
  writes++;if(loseReply)throw Error('transport reply lost');return{};
 }) as typeof ddb.send;
 try{
  const port=createLambdaSyncPort(),input:UpdateInventoryInput={id:'fixture',expectedUpdatedAt:oldVersion,quantity:11,images:[],customFields:undefined,updatedBy:'fixture',extendedFields:{}};
  const outcomes=await Promise.allSettled([port.updateInventory(input),port.updateInventory({...input,quantity:20})]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(writes,1);assert.equal(record.quantity,11);
  assert.equal((outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'CONFLICT');
  const before=calls;await assert.rejects(port.updateInventory({...input,expectedUpdatedAt:''}),e=>e instanceof InventorySaveError&&e.code==='CONFLICT');assert.equal(calls,before);
  loseReply=true;await assert.rejects(port.updateInventory({...input,expectedUpdatedAt:record.updatedAt,quantity:12}),e=>e instanceof InventorySaveError&&e.code==='UNCONFIRMED');assert.equal(writes,2);assert.equal(record.quantity,12);
  console.log('PASS: current Lambda transaction adapter rejects concurrent/stale/absent revisions and distinguishes lost acknowledgement; mocked DynamoDB transport only.');
 }finally{ddb.send=originalSend;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

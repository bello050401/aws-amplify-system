import assert from 'node:assert/strict';
import {sendInventoryTransaction} from '../lib/inventory/historyTransaction';
import {verifyHistoryImageObjects} from '../lib/inventory/historyImageGuard';
import {createQuickSearchMatcher} from '../lib/inventory/advancedSearch';

async function main() {
  const before={id:'test',name:'A',quantity:5,categoryIds:[],updatedAt:'2026-11-09T00:00:00.000Z'};
  const transaction={TransactItems:[{Update:{TableName:'Inventory-QA',Key:{id:'test'},UpdateExpression:'SET #n=:n, updatedAt=:u',ExpressionAttributeNames:{'#n':'name'},ExpressionAttributeValues:{':n':'B',':u':'2026-11-09T00:00:01.000Z'}}}]};
  let commands:unknown[]=[];
  const db={send:async(command:any)=>{commands.push(command.input);if(commands.length===1)throw Object.assign(Error('temporary throttle'),{name:'TransactionCanceledException',CancellationReasons:[{Code:'TransactionConflict'},{Code:'ThrottlingError'},{Code:'None'}]});return {};}};
  await sendInventoryTransaction(db as any,transaction,{source:'QA',before:new Map([['test',before]])});
  assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);
  commands=[];
  const conflict={send:async(command:any)=>{commands.push(command.input);throw Object.assign(Error('revision changed'),{name:'TransactionCanceledException',CancellationReasons:[{Code:'ConditionalCheckFailed'},{Code:'ThrottlingError'}]});}};
  await assert.rejects(sendInventoryTransaction(conflict as any,transaction,{source:'QA',before:new Map([['test',before]])}));assert.equal(commands.length,1);
  let heads=0;
  const images={send:async()=>{heads++;return {};}};
  await verifyHistoryImageObjects(images as any,'test-bucket',[{storageKey:'inventory/a.jpg'}],[{storageKey:'inventory/a.jpg'},{storageKey:'inventory/b.jpg'},{storageKey:'inventory/b.jpg'}]);assert.equal(heads,1);
  await assert.rejects(verifyHistoryImageObjects(images as any,'test-bucket',[],[{storageKey:'private/document.pdf'}]));assert.equal(heads,1);
  await assert.rejects(verifyHistoryImageObjects({send:async()=>{throw Error('missing');}} as any,'test-bucket',[],[{storageKey:'inventory/missing.jpg'}]));
  const row:any={name:'アルペール',sku:'A1'};
  const japanese=createQuickSearchMatcher('あるペール'),english=createQuickSearchMatcher('arper'),code=createQuickSearchMatcher('A1');
  assert(japanese(row));assert(english(row));assert(code(row));
  row.name='テーブル';row.sku='B2';assert(!japanese(row));assert(!english(row));assert(!code(row));
  assert(createQuickSearchMatcher('てーぶる')(row));
  console.log('PASS transient transaction retry retains exact token; revision conflicts never retry; image restore fails closed; search cache refreshes changed values');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

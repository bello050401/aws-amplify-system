import assert from 'node:assert/strict';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { markArchivedPhotoBatchAssets } from '../lib/mediaMaintenance/archivedPhotoBatches';
const id='11111111-1111-4111-8111-111111111111';
const batch:any={PK:`BATCH#${id}`,SK:`BATCH#${id}`,id,status:'ARCHIVED',deletedAt:'2026-10-01T00:00:00Z'};
function fixture(overrides:any={}) {
 const assets:any[]=[{PK:batch.PK,SK:'ASSET#1',id:'one',status:'READY',isDeleted:false,listingSelectionCount:0},
  {PK:batch.PK,SK:'ASSET#2',id:'referenced',status:'READY',isDeleted:false,listingSelectionCount:1}];
 const operations:any[]=[];
 const db={send:async(command:any)=>{const name=command.constructor.name;
  if(name==='GetCommand')return{Item:{...batch,...overrides}};
  if(name==='QueryCommand')return{Items:assets};
  if(name==='TransactWriteCommand') {operations.push(command.input); assets[0].isDeleted=true; return{};}
  throw Error(name);
 }} as DynamoDBDocumentClient;
 return {db,assets,operations};
}
async function main(){
 const x=fixture(); let r=await markArchivedPhotoBatchAssets(x.db,'test',id);
 assert.equal(r.marked,1);assert.equal(r.protected,1);
 const [parent,asset]=x.operations[0].TransactItems;
 assert(parent.ConditionCheck.ConditionExpression.includes('attribute_not_exists(inventoryId)'));
 assert(asset.Update.ConditionExpression.includes('listingSelectionCount = :zero'));
 assert(asset.Update.UpdateExpression.includes('purgeStartedAt'));
 assert.equal(asset.Update.ExpressionAttributeValues[':at'],batch.deletedAt);
 assert.equal((await markArchivedPhotoBatchAssets(x.db,'test',id)).marked,0);
 for(const overrides of [{status:'LINKED'},{inventoryId:'real-stock'},{openRevisionRevision:2}]){
  const y=fixture(overrides);assert.equal((await markArchivedPhotoBatchAssets(y.db,'test',id)).marked,0);assert.equal(y.operations.length,0);
 }
 const legacy=fixture({deletedAt:undefined});
 await markArchivedPhotoBatchAssets(legacy.db,'test',id,new Date('2026-10-23'));
 assert.equal(legacy.operations[0].TransactItems[1].Update.ExpressionAttributeValues[':at'],'2026-10-23T00:00:00.000Z');
 console.log('PASS archived cleanup: parent lock, reference protection, retry, legacy grace, upload protection');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

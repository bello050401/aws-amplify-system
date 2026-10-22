/** Read-only backup/inspection for the reported 20261023 arrival batch #2. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,GetCommand} from '@aws-sdk/lib-dynamodb';
import {fromIni} from '@aws-sdk/credential-providers';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2',credentials:fromIni({profile:'Bello'})}));
const table=model=>model+'-j6up24p7lnczdmklzjdt3vrp4y-NONE';
const report=path.resolve('../../artifacts/出庫履歴復旧_20261022');await fs.mkdir(report,{recursive:true});
const batches=(await db.send(new ScanCommand({TableName:table('OutboundBatch'),ConsistentRead:true}))).Items;
const matches=batches.filter(b=>b.orderNumber==='20261023入荷_2');
if(matches.length!==1)throw Error('Expected exactly the reported dispatch');
const batch=matches[0];
const items=(await db.send(new ScanCommand({TableName:table('OutboundItem'),FilterExpression:'batchId=:batch',ExpressionAttributeValues:{':batch':batch.id},ConsistentRead:true}))).Items;
const inventory=await Promise.all([...new Set(items.map(i=>i.splitInventoryId??i.inventoryId))].map(async id=>(await db.send(new GetCommand({TableName:table('Inventory'),Key:{id},ConsistentRead:true}))).Item));
const tag=process.argv.includes('--after')?'復旧後':'復旧前';
await fs.writeFile(path.join(report,tag+'_対象バックアップ.json'),JSON.stringify({capturedAt:new Date().toISOString(),batch,items,inventory},null,2));
if(process.argv.includes('--after')){
 const before=JSON.parse(await fs.readFile(path.join(report,'復旧前_対象バックアップ.json'),'utf8'));
 assert.equal(batch.emailMessageId,before.batch.emailMessageId);assert.equal(batch.emailSentAt,before.batch.emailSentAt);
 assert.equal(batch.status,'COMPLETED');assert.equal(items.length,before.items.length);
 for(const row of inventory){const original=before.inventory.find(r=>r.id===row.id);const strip=value=>Object.fromEntries(Object.entries(value).filter(([k])=>!['outboundBatchId','outboundArrivalBatchId'].includes(k)));assert.deepEqual(strip(row),strip(original));assert.equal(row.outboundArrivalBatchId,batch.id);}
 assert.ok(items.every(r=>r.status==='SENT'&&!r.arrivalStatus&&!r.error));
 const verification={batchId:batch.id,orderNumber:batch.orderNumber,products:items.length,quantity:inventory.reduce((sum,r)=>sum+r.quantity,0),classificationAndAllBusinessFieldsUnchanged:true,emailMessageIdAndSentAtUnchanged:true,arrival:'WAITING',verifiedAt:new Date().toISOString()};
 await fs.writeFile(path.join(report,'復旧確認.json'),JSON.stringify(verification,null,2));console.log(JSON.stringify(verification,null,2));process.exit(0);
}
console.log(JSON.stringify({batchId:batch.id,status:batch.status,emailStatus:batch.emailStatus,emailSentAt:batch.emailSentAt,arrivalWorkflow:batch.arrivalWorkflow,arrivalStatus:batch.arrivalStatus,products:items.map(i=>({id:i.inventoryId,status:i.status,error:i.error,splitInventoryId:i.splitInventoryId,snapshot:JSON.parse(i.snapshot),expectedUpdatedAt:i.expectedUpdatedAt})),inventory:inventory.map(r=>({id:r.id,sku:r.sku,quantity:r.quantity,categoryIds:r.categoryIds,locationId:r.locationId,updatedAt:r.updatedAt,outboundBatchId:r.outboundBatchId,outboundArrivalBatchId:r.outboundArrivalBatchId}))},null,2));

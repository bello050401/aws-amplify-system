/** Add the display definition and recover accepted dispatch names only.
 * No mail, movement, category, quantity, title, or direct ZAICO write.
 * Run plan first; apply uses captured versions and an atomic audit record.
 */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,GetCommand,PutCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {fromIni} from '@aws-sdk/credential-providers';
import {dispatchedCustomFields} from '../../lib/outbound/splitInventory';
const dir=path.resolve('artifacts/dispatch-name-scroll-20261029');
const table=(model:string)=>model+'-j6up24p7lnczdmklzjdt3vrp4y-NONE';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2',endpoint:'https://dynamodb.us-west-2.amazonaws.com',credentials:fromIni({profile:'Bello'}),maxAttempts:3}),{marshallOptions:{removeUndefinedValues:true}});
async function all(model:string){let cursor:any;const rows:any[]=[];do{const page=await db.send(new ScanCommand({TableName:table(model),ExclusiveStartKey:cursor,ConsistentRead:true}));rows.push(...page.Items??[]);cursor=page.LastEvaluatedKey;}while(cursor);return rows;}
const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v??{};
async function main(){
 fs.mkdirSync(dir,{recursive:true});
 const mode=process.argv[2];
 if(mode==='plan'){
  const [items,definitions]=await Promise.all([all('OutboundItem'),all('CustomFieldDefinition')]);
  const latest=new Map<string,any>();
  for(const item of items){if(item.status!=='SENT'||!item.sentAt)continue;const snapshot=parse(item.snapshot);
   if(snapshot.mergedIntoInventoryId)continue;
   const id=item.splitInventoryId||item.inventoryId;
   if(!latest.has(id)||latest.get(id).sentAt<item.sentAt)latest.set(id,{...item,snapshot});
  }
  const changes=[],skipped=[];
  for(const [id,item] of latest){
   const row=(await db.send(new GetCommand({TableName:table('Inventory'),Key:{id},ConsistentRead:true}))).Item;
   const name=String(item.snapshot.exportName??item.snapshot.name??'').trim();
   if(!row||row.deletedAt||row.listingPartition==='MERGED'||row.outboundBatchId||!name||parse(row.customFields).outboundName){skipped.push(id);continue;}
   // Historical name must match the accepted snapshot, without applying newer name rules.
   const custom=parse(dispatchedCustomFields(row,item));custom.outboundName=name;
   changes.push({id,sku:row.sku,sourceInventoryId:row.sourceInventoryId,expectedUpdatedAt:row.updatedAt,before:row,customFields:JSON.stringify(custom),batchId:item.batchId,outboundName:name});
  }
  const plan={createdAt:new Date().toISOString(),definitions,changes,skipped};
  fs.writeFileSync(path.join(dir,'backfill-plan-backup.json'),JSON.stringify(plan,null,2));
  console.log(JSON.stringify({acceptedItems:items.filter(i=>i.status==='SENT').length,changes:changes.map(c=>({sku:c.sku,sourceInventoryId:c.sourceInventoryId,name:c.outboundName})),skipped:skipped.length,definition:definitions.find(f=>f.fieldKey==='outboundName')??null}));
 }else if(mode==='apply'){
  const p=JSON.parse(fs.readFileSync(path.join(dir,'backfill-plan-backup.json'),'utf8'));
  const definitions=await all('CustomFieldDefinition'),now=new Date().toISOString();
  if(!definitions.some(f=>f.fieldKey==='outboundName'))await db.send(new PutCommand({TableName:table('CustomFieldDefinition'),Item:{id:'dispatch-name-definition-v1',fieldKey:'outboundName',label:'出庫時の名前',fieldType:'TEXT',isActive:true,sortOrder:Math.max(0,...definitions.map(f=>f.sortOrder??0))+1,createdAt:now,updatedAt:now,__typename:'CustomFieldDefinition'},ConditionExpression:'attribute_not_exists(id)'}));
  const applied=[];
  for(const c of p.changes){
   await db.send(new TransactWriteCommand({TransactItems:[
    {Update:{TableName:table('Inventory'),Key:{id:c.id},UpdateExpression:'SET customFields=:custom, updatedAt=:now, listUpdatedAt=:now',ConditionExpression:'updatedAt=:expected AND attribute_not_exists(deletedAt) AND attribute_not_exists(outboundBatchId)',ExpressionAttributeValues:{':custom':c.customFields,':now':now,':expected':c.expectedUpdatedAt}}},
    {Put:{TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId:c.id,fieldName:'出庫時の名前',oldValue:'',newValue:c.outboundName,changedAt:now,changedBy:'出庫履歴から記録補完',createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}}
   ]}));
   applied.push({id:c.id,sku:c.sku});fs.writeFileSync(path.join(dir,'backfill-applied.json'),JSON.stringify(applied));
  }
  console.log(JSON.stringify({applied:applied.length}));
 }else if(mode==='verify'){
  const p=JSON.parse(fs.readFileSync(path.join(dir,'backfill-plan-backup.json'),'utf8'));const results=[];
  for(const c of p.changes){
   const row=(await db.send(new GetCommand({TableName:table('Inventory'),Key:{id:c.id},ConsistentRead:true}))).Item!;
   const state=(await db.send(new GetCommand({TableName:table('ZaicoTransitionRecord'),Key:{id:'transition#item#'+c.id},ConsistentRead:true}))).Item;
   results.push({id:c.id,sku:c.sku,local:parse(row.customFields).outboundName===c.outboundName,zaico:state?.remoteBase?.['custom.outboundName']===c.outboundName,status:state?.status,masterUnchanged:['name','quantity','locationId','categoryIds'].every(key=>JSON.stringify(row[key])===JSON.stringify(c.before[key]))});
  }fs.writeFileSync(path.join(dir,'backfill-verified.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }else throw Error('Use plan|apply|verify');
}
main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

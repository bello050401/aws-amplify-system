import 'server-only';
import {randomUUID} from 'node:crypto';
import {GetCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable as table,categoryLinkChanges} from '@/lib/inventory/categoryPersistence';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {remainingCustomFields} from './splitInventory';
import {matchesOutboundMerge,mergeQuantities,mergedSourceCustom,MERGED_PARTITION} from './mergeInventory';
import {sendOutboundTransaction} from './transactionRetry';
import type {OutboundBatch,OutboundRow} from './types';

export async function findOutboundMergeTarget(source:Record<string,unknown>,locationId:string){
 if(!source.barcode||!source.name)return null;
 const candidates:Record<string,unknown>[]=[];let key:Record<string,unknown>|undefined;
 do{const page=await db.send(new ScanCommand({TableName:table('Inventory'),ConsistentRead:true,ExclusiveStartKey:key,
  FilterExpression:'barcode=:barcode AND #n=:name AND locationId=:location AND attribute_not_exists(deletedAt)',
  ExpressionAttributeNames:{'#n':'name'},ExpressionAttributeValues:{':barcode':source.barcode,':name':source.name,':location':locationId}}));
  candidates.push(...(page.Items??[]).filter(row=>matchesOutboundMerge(source,row,locationId)));key=page.LastEvaluatedKey;
 }while(key);
 // If older duplicate pages exist, use the oldest destination page consistently.
 return candidates.sort((a,b)=>String(a.createdAt??'').localeCompare(String(b.createdAt??''))||String(a.id).localeCompare(String(b.id)))[0]??null;
}

/** The source decrement, destination increment and receipt are one transaction. */
export async function applyOutboundMerge(source:Record<string,unknown>,item:OutboundRow,batch:OutboundBatch,actor:string):Promise<boolean>{
 for(let attempt=0;attempt<5;attempt++){
  const target=await findOutboundMergeTarget(source,batch.locationId);if(!target)return false;
  if(target.outboundBatchId)throw Error('合算先が別の出庫処理中です。処理完了後に更新結果を再確認してください。');
  const {remaining,before,after}=mergeQuantities(source,target,item.snapshot.quantity);
  const now=new Date(Math.max(Date.now(),Date.parse(String(target.updatedAt))+1,Date.parse(String(source.updatedAt))+1)).toISOString();
  const categories=inventoryCategoryIds(source),sourceChanges=remaining?{quantity:remaining}:{quantity:0,categoryIds:[],categoryId:null};
  const snapshot={...item.snapshot,mergedIntoInventoryId:target.id,mergedIntoSku:target.sku,mergeQuantityBefore:before,mergeQuantityAfter:after};
  try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
   {ConditionCheck:{TableName:table('OutboundBatch'),Key:{id:batch.id},ConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':'APPLYING'}}},
   {Update:{TableName:table('Inventory'),Key:{id:source.id},
    UpdateExpression:'SET quantity=:q, customFields=:custom, updatedAt=:now, listUpdatedAt=:now, updatedBy=:who'+(!remaining?', listingPartition=:merged, categoryIds=:cats':'')+' REMOVE outboundBatchId'+(!remaining?', categoryId':''),
    ConditionExpression:'outboundBatchId=:batch AND updatedAt=:version AND quantity=:available AND attribute_not_exists(deletedAt)',
    ExpressionAttributeValues:{':q':remaining,':custom':remaining?remainingCustomFields(source,remaining):mergedSourceCustom(source,sourceChanges,String(target.id),batch.id,now),':now':now,':who':actor,':batch':batch.id,':version':item.expectedUpdatedAt,':available':Number(source.quantity),...(!remaining?{':merged':MERGED_PARTITION,':cats':[]}:{})}}},
   {Update:{TableName:table('Inventory'),Key:{id:target.id},UpdateExpression:'SET quantity=:q, customFields=:custom, updatedAt=:now, listUpdatedAt=:now, updatedBy=:who',
    ConditionExpression:'updatedAt=:version AND quantity=:before AND barcode=:barcode AND #n=:name AND locationId=:loc AND attribute_not_exists(deletedAt) AND attribute_not_exists(outboundBatchId) AND (attribute_not_exists(listingPartition) OR listingPartition<>:merged)',
    ExpressionAttributeNames:{'#n':'name'},ExpressionAttributeValues:{':q':after,':custom':remainingCustomFields(target,after),':now':now,':who':actor,':version':target.updatedAt,':before':before,':barcode':source.barcode,':name':source.name,':loc':batch.locationId,':merged':MERGED_PARTITION}}},
   ...(!remaining?categoryLinkChanges(String(source.id),categories,[],now):[]),
   {Update:{TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET #s=:sent,  #snapshot=:snapshot, sentAt=:now, sentBy=:who, updatedAt=:now REMOVE #error',ConditionExpression:'#s=:pending',ExpressionAttributeNames:{'#s':'status','#error':'error','#snapshot':'snapshot'},ExpressionAttributeValues:{':sent':'SENT',':pending':'PENDING',':snapshot':JSON.stringify(snapshot),':now':now,':who':actor}}},
   ...[source.id,target.id].map(inventoryId=>({Put:{TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId,changedAt:now,changedBy:actor,fieldName:'出庫・数量合算',oldValue:JSON.stringify({sourceQuantity:source.quantity,targetQuantity:before,sourceLocationId:source.locationId,sourceCategoryIds:categories}),newValue:JSON.stringify({batchId:batch.id,sourceInventoryId:source.id,mergedIntoInventoryId:target.id,movedQuantity:item.snapshot.quantity,remainingQuantity:remaining,targetQuantity:after,locationId:batch.locationId}),createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}})),
  ]}));return true;}catch(error){
   const fresh=(await db.send(new GetCommand({TableName:table('OutboundItem'),Key:{id:item.id},ConsistentRead:true}))).Item;
   if(fresh?.status==='SENT')return true;
   if((error as Error).name!=='TransactionCanceledException')throw error;
  }
 }
 throw Error('合算先の更新が重なりました。メールは再送せず、更新結果を再確認してください。');
}

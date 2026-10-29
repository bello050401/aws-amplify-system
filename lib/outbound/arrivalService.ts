import 'server-only';
import {randomUUID} from 'node:crypto';
import {GetCommand,ScanCommand,TransactWriteCommand,UpdateCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable as table,getInventoryRaw,categoryLinkChanges} from '@/lib/inventory/categoryPersistence';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {withHumanEdits} from '@/lib/inventory/humanEdits';
import {parseCustomFields,stringifyCustomFields} from '@/lib/inventory/customFieldsCodec';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {getOutboundBatch,requireUuid,pendingArrivalInventoryIds} from './service';
import {parseJsonField} from './types';
import {isArrivalRow,arrivalFailureMessage,type ArrivalChange,type ArrivalPreview} from './arrivalTypes';
import {sendOutboundTransaction} from './transactionRetry';

async function masters(model:string){
 const items:{id:string;name:string}[]=[];let key:ScanCommandOutput['LastEvaluatedKey'];
 do{const p=await db.send(new ScanCommand({TableName:table(model),ConsistentRead:true,ExclusiveStartKey:key}));
  items.push(...(p.Items??[]).filter(r=>r.isActive!==false).map(r=>({id:String(r.id),name:String(r.name)})));key=p.LastEvaluatedKey;
 }while(key);
 return items.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
}

export async function previewOutboundArrival(id:string):Promise<ArrivalPreview>{
 const batch=await getOutboundBatch(id),[categories,locations]=await Promise.all([masters('Category'),masters('Location')]);
 const items=[],otherPending=await pendingArrivalInventoryIds(id);
 for(const item of batch.rows.filter(r=>isArrivalRow(r)&&r.arrivalStatus!=='COMPLETED')){
  const inventoryId=item.splitInventoryId??item.inventoryId,row=await getInventoryRaw(inventoryId);
  const error=!row||row.deletedAt||row.listingPartition==='MERGED'?'商品が削除・合算されています。商品と出庫履歴を確認してください。':
   row.outboundBatchId||row.outboundArrivalBatchId&&row.outboundArrivalBatchId!==id||otherPending.has(inventoryId)?'別の出庫でも到着確認待ちです。重複する出庫履歴を確認してください。':
   Number(row.quantity)!==item.snapshot.quantity?'出庫後に数量が変更されています。対象商品の数量を確認してください。':undefined;
  const categoryIds=inventoryCategoryIds(row??{});
  items.push({rowId:item.id,inventoryId,sku:String(row?.sku??item.splitSku??item.snapshot.sku),name:String(row?.name??item.snapshot.name),quantity:item.snapshot.quantity,
   updatedAt:String(row?.updatedAt??''),locationId:String(row?.locationId??''),categoryIds,defaultCategoryIds:categoryIds.filter(c=>c!==batch.categoryId),...(error?{error}:{})});
 }
 return {batch,items,categories,locations};
}

/** One durable approved plan; each product, category links and journal commit together. */
export async function confirmOutboundArrival(id:string,commandId:string,changes:ArrivalChange[],actor:string){
 requireUuid(commandId);
 let batch=await getOutboundBatch(id);
 if(batch.status!=='COMPLETED')throw Error('出庫の完了を確認してから到着確認を行ってください。');
 const arrivalRows=batch.rows.filter(isArrivalRow);
 if(!arrivalRows.length)throw Error('この履歴には到着確認待ちの商品がありません。');
 if(arrivalRows.every(r=>r.arrivalStatus==='COMPLETED')){
  // Product transactions can all succeed just before a timeout. Finish the
  // batch journal on retry without touching those products a second time.
  if(batch.arrivalStatus!=='COMPLETED'&&batch.arrivalCommandId){
   try{await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id},UpdateExpression:'SET arrivalStatus=:done, arrivalAt=:now, arrivalBy=:actor, updatedAt=:now',ConditionExpression:'arrivalCommandId=:cmd',ExpressionAttributeValues:{':done':'COMPLETED',':now':new Date().toISOString(),':actor':actor,':cmd':batch.arrivalCommandId}}));}
   catch{throw Error('商品の更新は完了していますが、履歴の確定を確認できません。結果を再確認してください。');}
   clearInventoryCountCache();return getOutboundBatch(id);
  }
  return batch;
 }
 if(batch.arrivalCommandId!==commandId){
  if(batch.arrivalStatus==='APPLYING')throw Error('到着確認の処理中です。「確認」で結果を確認してください。');
  const preview=await previewOutboundArrival(id);
  if(!Array.isArray(changes)||changes.length!==preview.items.length||new Set(changes.map(c=>c.rowId)).size!==changes.length)throw Error('この出庫に含まれる未更新の商品をすべて確認してください。');
  const categoryIds=new Set(preview.categories.map(c=>c.id)),locationIds=new Set(preview.locations.map(l=>l.id));
  for(const change of changes){
   const row=preview.items.find(i=>i.rowId===change.rowId);
   if(!row||row.inventoryId!==change.inventoryId)throw Error('別の出庫の商品は更新できません。');
   if(row.error)throw Error(`${row.sku}：${row.error}`);
   if(row.updatedAt!==change.expectedUpdatedAt)throw Error(`${row.sku}は変更されています。内容を読み直してください。`);
   if(!locationIds.has(change.locationId)||!Array.isArray(change.categoryIds)||change.categoryIds.length>20||new Set(change.categoryIds).size!==change.categoryIds.length||change.categoryIds.some(c=>!categoryIds.has(c)))throw Error('有効な保管場所・カテゴリを選んでください。');
  }
  const plan=changes.map(c=>({rowId:c.rowId,inventoryId:c.inventoryId,expectedUpdatedAt:c.expectedUpdatedAt,locationId:c.locationId,categoryIds:c.categoryIds}));
  try{await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id},
   UpdateExpression:'SET arrivalCommandId=:cmd, arrivalPlan=:plan, arrivalStatus=:applying, updatedAt=:now',
   ConditionExpression:'#s=:completed AND '+(batch.arrivalCommandId?'arrivalCommandId=:old AND arrivalStatus=:partial':'attribute_not_exists(arrivalCommandId)'),
   ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':completed':'COMPLETED',':cmd':commandId,':plan':JSON.stringify(plan),':applying':'APPLYING',':now':new Date().toISOString(),...(batch.arrivalCommandId?{':old':batch.arrivalCommandId,':partial':'PARTIAL'}:{})}}));
  }catch{const fresh=await getOutboundBatch(id);if(fresh.arrivalCommandId!==commandId)throw Error('別の端末で到着確認が行われました。履歴を読み直してください。');}
 }else if(batch.arrivalStatus==='PARTIAL'){
  await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id},UpdateExpression:'SET arrivalStatus=:applying',ConditionExpression:'arrivalCommandId=:cmd AND arrivalStatus=:partial',ExpressionAttributeValues:{':applying':'APPLYING',':cmd':commandId,':partial':'PARTIAL'}}));
 }
 batch=await getOutboundBatch(id);
 const plan=parseJsonField<ArrivalChange[]>(batch.arrivalPlan,[]);
 if(!plan.length)throw Error('確認済みの変更内容が見つかりません。履歴を読み直してください。');
 for(const change of plan){
  const item=batch.rows.find(r=>r.id===change.rowId);
  if(!item||!isArrivalRow(item))throw Error('到着確認の商品情報が一致しません。');
  if(item.arrivalStatus==='COMPLETED')continue;
  try{
   const row=await getInventoryRaw(change.inventoryId);
   if(!row||row.deletedAt||row.listingPartition==='MERGED'||row.outboundBatchId||row.updatedAt!==change.expectedUpdatedAt||Number(row.quantity)!==item.snapshot.quantity||row.outboundArrivalBatchId&&row.outboundArrivalBatchId!==id)throw Error('商品が変更されています。変更内容を読み直して再確認してください。');
   const refs=await Promise.all([['Location',change.locationId],...change.categoryIds.map(c=>['Category',c])].map(async([model,key])=>({model,key,row:(await db.send(new GetCommand({TableName:table(model),Key:{id:key},ConsistentRead:true}))).Item})));
   if(refs.some(r=>!r.row||r.row.isActive===false))throw Error('保管場所またはカテゴリが無効です。選び直してください。');
   const now=new Date(Math.max(Date.now(),Date.parse(row.updatedAt)+1)).toISOString(),before=inventoryCategoryIds(row);
   const after={categoryId:change.categoryIds[0]??null,categoryIds:change.categoryIds,locationId:change.locationId};
   const previous={categoryIds:before,locationId:row.locationId??null};
   const journal={before:previous,after,quantity:row.quantity,batchId:id,inventoryId:change.inventoryId,commandId};
   const custom=withHumanEdits(row,after,parseCustomFields(row.customFields),parseCustomFields(row.customFields)??{});
   await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
    {ConditionCheck:{TableName:table('OutboundBatch'),Key:{id},ConditionExpression:'arrivalCommandId=:cmd AND arrivalStatus=:applying',ExpressionAttributeValues:{':cmd':commandId,':applying':'APPLYING'}}},
    ...refs.map(ref=>({ConditionCheck:{TableName:table(ref.model),Key:{id:ref.key},ConditionExpression:'attribute_exists(id) AND '+(ref.row!.isActive===undefined?'attribute_not_exists(isActive)':'isActive=:active'),...(ref.row!.isActive===undefined?{}:{ExpressionAttributeValues:{':active':ref.row!.isActive}})}})),
    {Update:{TableName:table('Inventory'),Key:{id:change.inventoryId},UpdateExpression:'SET categoryIds=:cats, locationId=:loc, customFields=:custom, updatedAt=:now, listUpdatedAt=:now, updatedBy=:actor'+(after.categoryId?', categoryId=:primary':'')+' REMOVE outboundArrivalBatchId'+(after.categoryId?'':', categoryId'),
     ConditionExpression:'updatedAt=:version AND quantity=:qty AND attribute_not_exists(deletedAt) AND attribute_not_exists(outboundBatchId) AND '+(row.outboundArrivalBatchId?'outboundArrivalBatchId=:batch':'attribute_not_exists(outboundArrivalBatchId)'),
     ExpressionAttributeValues:{':cats':after.categoryIds,':loc':after.locationId,':custom':stringifyCustomFields(custom),':now':now,':actor':actor,':version':change.expectedUpdatedAt,':qty':item.snapshot.quantity,...(after.categoryId?{':primary':after.categoryId}:{}),...(row.outboundArrivalBatchId?{':batch':id}:{})}}},
    ...categoryLinkChanges(change.inventoryId,before,after.categoryIds,now),
    {Update:{TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET arrivalStatus=:completed, arrivalAt=:now, arrivalBy=:actor, arrivalChanges=:journal, updatedAt=:now REMOVE arrivalError',
     ConditionExpression:'#s=:sent AND '+(item.arrivalStatus?'arrivalStatus=:old':'attribute_not_exists(arrivalStatus)'),ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':sent':'SENT',':completed':'COMPLETED',':now':now,':actor':actor,':journal':JSON.stringify(journal),...(item.arrivalStatus?{':old':item.arrivalStatus}:{})}}},
    {Put:{TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId:change.inventoryId,changedAt:now,changedBy:actor,fieldName:'出庫・到着確認',oldValue:JSON.stringify(previous),newValue:JSON.stringify({...after,batchId:id,commandId,quantity:row.quantity}),createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}},
   ]}));
  }catch(error){
   const fresh=(await db.send(new GetCommand({TableName:table('OutboundItem'),Key:{id:item.id},ConsistentRead:true}))).Item;
   if(fresh?.arrivalStatus==='COMPLETED')continue;
   console.error('[outbound-arrival]',{batchId:id,itemId:item.id,error});
   const message=arrivalFailureMessage(error);
   try{await db.send(new UpdateCommand({TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET arrivalError=:error',ConditionExpression:'attribute_not_exists(arrivalStatus)',ExpressionAttributeValues:{':error':message}}));}catch{/* A concurrent retry may already have completed this item. */}
  }
 }
 const fresh=await getOutboundBatch(id),complete=fresh.rows.filter(isArrivalRow).every(r=>r.arrivalStatus==='COMPLETED');
 try{await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id},UpdateExpression:'SET arrivalStatus=:status, updatedAt=:now'+(complete?', arrivalAt=:now, arrivalBy=:actor':''),ConditionExpression:'arrivalCommandId=:cmd AND arrivalStatus=:applying',ExpressionAttributeValues:{':cmd':commandId,':applying':'APPLYING',':status':complete?'COMPLETED':'PARTIAL',':now':new Date().toISOString(),...(complete?{':actor':actor}:{})}}));}catch{const result=await getOutboundBatch(id);if(result.arrivalStatus!=='COMPLETED')throw Error('完了状態を確認できません。履歴から「確認」を押して再確認してください。');}
 clearInventoryCountCache();return getOutboundBatch(id);
}

export async function confirmDefaultOutboundArrival(id:string,commandId:string,actor:string){
 requireUuid(id);requireUuid(commandId);
 const batch=await getOutboundBatch(id);
 if(batch.arrivalCommandId===commandId||batch.arrivalStatus==='APPLYING'||batch.arrivalStatus==='COMPLETED'){
  return confirmOutboundArrival(id,batch.arrivalCommandId??commandId,[],actor);
 }
 const preview=await previewOutboundArrival(id);
 return confirmOutboundArrival(id,commandId,preview.items.map(item=>({
  rowId:item.rowId,inventoryId:item.inventoryId,expectedUpdatedAt:item.updatedAt,locationId:batch.locationId,
  categoryIds:item.defaultCategoryIds,
 })),actor);
}

import {sendOutboundTransaction} from './transactionRetry';
import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import {GetCommand,PutCommand,ScanCommand,TransactWriteCommand,UpdateCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable as table,getInventoryRaw,categoryLinkChanges} from '@/lib/inventory/categoryPersistence';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {withHumanEdits} from '@/lib/inventory/humanEdits';
import {parseCustomFields,stringifyCustomFields} from '@/lib/inventory/customFieldsCodec';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {inventoryThumbnails} from '@/lib/mobile/inventoryThumbnails';
import type {InventoryListRow} from '@/lib/inventory/queries';
import {outboundThumbnailFields} from './productThumbnail';
import {DEFAULT_OUTBOUND_COLUMNS,parseJsonField,type OutboundDestination,type OutboundBatch,type OutboundRow,type OutboundProduct} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUuid(id:unknown):asserts id is string {if(typeof id!=='string'||!uuid.test(id))throw new Error('対象を選び直してください。');}
async function all(model:string,filter?:{expression:string;values:Record<string,unknown>;names?:Record<string,string>}) {
  const items:NonNullable<ScanCommandOutput['Items']>=[];let key:Record<string,unknown>|undefined;
  do {const p=await db.send(new ScanCommand({TableName:table(model),ConsistentRead:true,ExclusiveStartKey:key,
    ...(filter?{FilterExpression:filter.expression,ExpressionAttributeValues:filter.values,ExpressionAttributeNames:filter.names}:{})}));items.push(...p.Items??[]);key=p.LastEvaluatedKey;}while(key);
  return items;
}
export async function outboundDestinations():Promise<OutboundDestination[]> {
  return (await all('OutboundDestination')).filter(row=>row.isActive!==false).map(row=>({...row,template:parseJsonField(row.template,DEFAULT_OUTBOUND_COLUMNS)}) as OutboundDestination).sort((a,b)=>a.sortOrder-b.sortOrder);
}
export async function outboundMovementOptions(){
  const categories=new Map((await all('Category')).filter(c=>c.isActive!==false).map(c=>[c.id,c.name]));
  const unique=new Map<string,{id:string;name:string;categoryName:string}>();
  for(const d of await outboundDestinations()) if(categories.has(d.categoryId)&&!unique.has(d.categoryId)) unique.set(d.categoryId,{id:d.id,name:d.name,categoryName:categories.get(d.categoryId)!});
  return [...unique.values()];
}
async function destination(id:string) {
  const value=(await outboundDestinations()).find(d=>d.id===id);
  if(!value)throw new Error('出庫先の設定が見つかりません。');
  const refs=await Promise.all(['Category','Location'].map((model,i)=>db.send(new GetCommand({TableName:table(model),Key:{id:i?value.locationId:value.categoryId},ConsistentRead:true}))));
  if(refs.some(ref=>!ref.Item || ref.Item.isActive===false))throw new Error('出庫先のカテゴリ・保管場所の設定を確認してください。');
  return value;
}
export async function outboundProducts(destinationId:string):Promise<OutboundProduct[]> {
  const dest=await destination(destinationId);
  const rows=(await all('Inventory',{expression:'attribute_not_exists(deletedAt) AND (contains(categoryIds,:cat) OR (attribute_not_exists(categoryIds) AND categoryId = :cat))',values:{':cat':dest.categoryId}}))
    .filter(row=>!row.outboundBatchId);
  const locations=new Map((await all('Location')).map(l=>[l.id,l.name]));
  // Resolve the same signed thumbnails as the staff list, including PhotoStation assets.
  const thumbs=await inventoryThumbnails(rows.map(row=>({...row,...outboundThumbnailFields(row.images)})) as InventoryListRow[]);
  const byId=new Map(thumbs.map(t=>[t.id,t.thumbnailUrl]));
  return rows.map(row=>({id:row.id,sku:row.sku,name:row.name,barcode:row.barcode??'',quantity:row.quantity??0,unit:row.unit??'',updatedAt:row.updatedAt,
    width:row.width??'',depth:row.depth??'',height:row.height??'',location:locations.get(row.locationId)??'',thumbnailUrl:byId.get(row.id)??null}));
}
export async function getOutboundBatch(id:string):Promise<OutboundBatch> {
  requireUuid(id);
  const result=await db.send(new GetCommand({TableName:table('OutboundBatch'),Key:{id},ConsistentRead:true}));
  if(!result.Item)throw new Error('出庫履歴が見つかりません。');
  const rows=(await all('OutboundItem',{expression:'batchId = :id',values:{':id':id}})).map(row=>({...row,snapshot:parseJsonField(row.snapshot,{} as OutboundProduct)}) as OutboundRow);
  return {...result.Item,template:parseJsonField(result.Item.template,DEFAULT_OUTBOUND_COLUMNS),rows:rows.sort((a,b)=>a.snapshot.sku.localeCompare(b.snapshot.sku))} as OutboundBatch;
}
export async function outboundHistory() {
  return (await all('OutboundBatch')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(row=>({id:row.id,destinationName:row.destinationName,createdAt:row.createdAt,status:row.status}));
}
/** The caller supplies one stable command ID. A lost response must reuse it. */
export async function prepareOutbound(id:string,destinationId:string,selected:{id:string;updatedAt:string}[],actor:string):Promise<OutboundBatch> {
  requireUuid(id);requireUuid(destinationId);
  if(!Array.isArray(selected)||!selected.length||selected.length>200||new Set(selected.map(x=>x.id)).size!==selected.length)throw new Error('1〜200商品を選択してください。');
  selected.forEach(row=>{requireUuid(row.id);if(!Number.isFinite(Date.parse(row.updatedAt)))throw new Error('商品を読み直してください。');});
  const fingerprint=createHash('sha256').update(JSON.stringify([destinationId,[...selected].sort((a,b)=>a.id.localeCompare(b.id))])).digest('hex');
  let batch:OutboundBatch;
  const existing=await db.send(new GetCommand({TableName:table('OutboundBatch'),Key:{id},ConsistentRead:true}));
  if(existing.Item) {
    if(existing.Item.fingerprint!==fingerprint||existing.Item.requestedBy!==actor)throw new Error('同じ処理番号で別の出庫は実行できません。');
    batch=await getOutboundBatch(id);
  } else {
    const dest=await destination(destinationId),now=new Date().toISOString();
    if(dest.preparationStatus==='ON_HOLD')throw new Error('この出庫先の送信データ作成は保留中です。');
    if(dest.preparationStatus!=='READY')throw new Error('送信用テンプレートの準備ができていません。対象商品の確認はできます。');
    if(dest.sender!=='MANUAL')throw new Error('Slack連携は準備中です。まだ送信できません。');
    const stamp=now.replaceAll(/[-:.TZ]/g,'').slice(0,14);
    const filename=dest.fileNamePattern.replaceAll('{destination}',dest.name).replaceAll('{date}',stamp).replaceAll('{id}',id.slice(0,8)).replace(/[\\/:*?"<>|\r\n]/g,'_');
    const record={id,destinationId,destinationName:dest.name,categoryId:dest.categoryId,locationId:dest.locationId,status:'PREPARING',
      requestedBy:actor,fingerprint,template:JSON.stringify(dest.template),fileName:filename.endsWith('.csv')?filename:filename+'.csv',sender:dest.sender,createdAt:now,updatedAt:now,__typename:'OutboundBatch'};
    try{await db.send(new PutCommand({TableName:table('OutboundBatch'),Item:record,ConditionExpression:'attribute_not_exists(id)'}));}
    catch(error){const concurrent=await getOutboundBatch(id);if(concurrent.fingerprint!==fingerprint||concurrent.requestedBy!==actor)throw error;}
    batch=await getOutboundBatch(id);
  }
  if(batch.status!=='PREPARING')return batch;
  const recorded=new Set(batch.rows.map(row=>row.inventoryId));
  const locations=new Map((await all('Location')).map(row=>[row.id,row.name]));
  for(const selection of selected) {
    if(recorded.has(selection.id))continue;
    const row=await getInventoryRaw(selection.id),now=new Date().toISOString();
    const snapshot:OutboundProduct={id:selection.id,sku:String(row?.sku??''),name:String(row?.name??'削除された商品'),barcode:String(row?.barcode??''),quantity:Number(row?.quantity??0),unit:String(row?.unit??''),updatedAt:selection.updatedAt,location:locations.get(row?.locationId)??'',width:row?.width??'',depth:row?.depth??'',height:row?.height??''};
    const error=!row||row.deletedAt?'商品が削除されています。':row.updatedAt!==selection.updatedAt?'別の端末で変更されています。':!inventoryCategoryIds(row).includes(batch.categoryId)?'移動予定が変更済みです。':row.outboundBatchId?'別の出庫で選択済みです。':null;
    const item={id:`${id}:${selection.id}`,batchId:id,inventoryId:selection.id,status:error?'SKIPPED':'PENDING',snapshot:JSON.stringify(snapshot),expectedUpdatedAt:selection.updatedAt,error:error??null,createdAt:now,updatedAt:now,__typename:'OutboundItem'};
    if(error){try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[batchStateCheck(id,'PREPARING'),{Put:{TableName:table('OutboundItem'),Item:item,ConditionExpression:'attribute_not_exists(id)'}}]}));}catch(cause){const fresh=await getOutboundBatch(id);if(fresh.status!=='PREPARING')return fresh;if(!fresh.rows.some(r=>r.id===item.id))throw cause;}continue;}
    try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
      batchStateCheck(id,'PREPARING'),
      {Update:{TableName:table('Inventory'),Key:{id:selection.id},UpdateExpression:'SET outboundBatchId = :batch',ConditionExpression:'updatedAt = :version AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(deletedAt)',ExpressionAttributeValues:{':batch':id,':version':selection.updatedAt}}},
      {Put:{TableName:table('OutboundItem'),Item:item,ConditionExpression:'attribute_not_exists(id)'}},
    ]}));}catch(error){
      const state=await getOutboundBatch(id);if(state.status!=='PREPARING')return state;
      const saved=await db.send(new GetCommand({TableName:table('OutboundItem'),Key:{id:item.id},ConsistentRead:true}));
      if(!saved.Item) {
        if(!(error instanceof Error)||error.name!=='TransactionCanceledException')throw error;
        try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[batchStateCheck(id,'PREPARING'),{Put:{TableName:table('OutboundItem'),Item:{...item,status:'SKIPPED',error:'別の操作と重なったため除外しました。'},ConditionExpression:'attribute_not_exists(id)'}}]}));}catch(cause){const fresh=await getOutboundBatch(id);if(fresh.status!=='PREPARING')return fresh;if(!fresh.rows.some(r=>r.id===item.id))throw cause;}
      }
    }
  }
  // No sender is configured initially. Keeping the document pending never changes location/categories.
  await updateBatchStatus(id,'AWAITING_SEND',['PREPARING']);
  return getOutboundBatch(id);
}
function batchStateCheck(id:string,status:string){return {ConditionCheck:{TableName:table('OutboundBatch'),Key:{id},ConditionExpression:'#s = :s',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':status}}};}
async function updateBatchStatus(id:string,status:string,from:string[]) {
  try{await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id},UpdateExpression:'SET #s = :s, updatedAt = :now',ConditionExpression:'#s IN ('+from.map((_,i)=>`:f${i}`).join(',')+')',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':status,':now':new Date().toISOString(),...Object.fromEntries(from.map((s,i)=>[`:f${i}`,s]))}}));return true;}
  catch(e){if(e instanceof Error&&e.name==='ConditionalCheckFailedException')return false;throw e;}
}
export async function confirmOutboundSent(batchId:string,actor:string):Promise<OutboundBatch> {
  const batch=await getOutboundBatch(batchId);
  if(batch.status==='CANCELLED'||batch.status==='CANCELLING')throw new Error('この出庫データは取り消されています。');
  if(batch.status==='PREPARING')throw new Error('データを作成中です。もう一度結果を確認してください。');
  if(batch.sender!=='MANUAL')throw new Error('送信方法が未対応です。管理者に設定の確認を依頼してください。');
  if(batch.status==='COMPLETED')return batch;
  if(!await updateBatchStatus(batchId,'APPLYING',['AWAITING_SEND','PARTIAL','APPLYING']))throw new Error('出庫の状態が変わりました。履歴を確認してください。');
  for(const item of batch.rows.filter(row=>row.status==='PENDING')) {
    const row=await getInventoryRaw(item.inventoryId);
    if(!row||row.outboundBatchId!==batchId||row.updatedAt!==item.expectedUpdatedAt){await recordPendingError(item.id,'対象商品が更新されています。送信内容と履歴を確認してください。自動再送は行いません。');continue;}
    const now=new Date().toISOString(),before=inventoryCategoryIds(row),after=before.filter(cat=>cat!==batch.categoryId);
    const changes={categoryId:after[0]??null,categoryIds:after,locationId:batch.locationId};
    const custom=withHumanEdits(row,changes,parseCustomFields(row.customFields),parseCustomFields(row.customFields)??{});
    try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
      batchStateCheck(batchId,'APPLYING'),
      {Update:{TableName:table('Inventory'),Key:{id:item.inventoryId},UpdateExpression:'SET '+(after.length?'categoryId = :primary, ':'')+'categoryIds = :cats, locationId = :loc, updatedAt = :now, listUpdatedAt = :now, updatedBy = :who, customFields = :custom REMOVE outboundBatchId'+(after.length?'':', categoryId'),
        ConditionExpression:'outboundBatchId = :batch AND updatedAt = :version AND attribute_not_exists(deletedAt)',ExpressionAttributeValues:{...(after.length?{':primary':after[0]}:{}),':cats':after,':loc':batch.locationId,':now':now,':who':actor,':custom':stringifyCustomFields(custom),':batch':batchId,':version':item.expectedUpdatedAt}}},
      ...categoryLinkChanges(item.inventoryId,before,after,now),
      {Update:{TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET #s = :sent, sentAt = :now, sentBy = :actor, updatedAt = :now REMOVE #error',ConditionExpression:'#s = :pending',ExpressionAttributeNames:{'#s':'status','#error':'error'},ExpressionAttributeValues:{':sent':'SENT',':pending':'PENDING',':now':now,':actor':actor}}},
      {Put:{TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId:item.inventoryId,changedAt:now,changedBy:actor,fieldName:'出庫',oldValue:JSON.stringify({categoryIds:before,locationId:row.locationId}),newValue:JSON.stringify({...changes,destination:batch.destinationName,batchId}),createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}},
    ]}));}catch(error){const fresh=await db.send(new GetCommand({TableName:table('OutboundItem'),Key:{id:item.id},ConsistentRead:true}));if(fresh.Item?.status!=='SENT'){console.error('[outbound-apply]',error);await recordPendingError(item.id,'更新結果を確認できません。履歴から保存結果を確認してください。');}}
  }
  const result=await getOutboundBatch(batchId);
  await updateBatchStatus(batchId,result.rows.some(r=>r.status==='PENDING')?'PARTIAL':'COMPLETED',['APPLYING']);clearInventoryCountCache();
  return getOutboundBatch(batchId);
}
/** Only unsent reservations can be cancelled. Completed movement is never silently reversed. */
export async function cancelUnsentOutbound(batchId:string):Promise<OutboundBatch> {
  let batch=await getOutboundBatch(batchId);
  if(batch.status==='CANCELLED')return batch;
  if(batch.rows.some(row=>row.status==='SENT'))throw new Error('送信済みの商品があります。出庫の取り消しはできません。');
  if(!await updateBatchStatus(batchId,'CANCELLING',['PREPARING','AWAITING_SEND','CANCELLING']))throw new Error('送信確認または更新処理中です。結果を確認してから操作してください。');
  batch=await getOutboundBatch(batchId);
  for(const item of batch.rows.filter(row=>row.status==='PENDING'))try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
    batchStateCheck(batchId,'CANCELLING'),
    {Update:{TableName:table('Inventory'),Key:{id:item.inventoryId},UpdateExpression:'REMOVE outboundBatchId',ConditionExpression:'outboundBatchId = :batch',ExpressionAttributeValues:{':batch':batchId}}},
    {Update:{TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET #s = :cancel',ConditionExpression:'#s = :pending',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':cancel':'CANCELLED',':pending':'PENDING'}}},
  ]}));}catch(error){const fresh=await getOutboundBatch(batchId);if(fresh.rows.find(r=>r.id===item.id)?.status!=='CANCELLED')throw error;}
  await updateBatchStatus(batchId,'CANCELLED',['CANCELLING']);return getOutboundBatch(batchId);
}
async function recordPendingError(id:string,message:string){try{await db.send(new UpdateCommand({TableName:table('OutboundItem'),Key:{id},UpdateExpression:'SET #e=:e',ConditionExpression:'#s=:p',ExpressionAttributeNames:{'#s':'status','#e':'error'},ExpressionAttributeValues:{':p':'PENDING',':e':message}}));}catch(e){if(!(e instanceof Error)||e.name!=='ConditionalCheckFailedException')throw e;}}

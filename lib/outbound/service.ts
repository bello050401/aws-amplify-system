import {sendOutboundTransaction} from './transactionRetry';
import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import {GetCommand,PutCommand,ScanCommand,TransactWriteCommand,UpdateCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db,inventoryTable as table,getInventoryRaw,categoryLinkChanges} from '@/lib/inventory/categoryPersistence';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {inventoryThumbnails} from '@/lib/mobile/inventoryThumbnails';
import type {InventoryListRow} from '@/lib/inventory/queries';
import {outboundThumbnailFields} from './productThumbnail';
import {DEFAULT_OUTBOUND_COLUMNS,parseJsonField,type OutboundDestination,type OutboundBatch,type OutboundRow,type OutboundProduct,type OutboundSelection} from './types';
import {KAWAGOE_TEMPLATE,kawagoeAttachments,orderNumber,validateArrivalDate,validateBarcode,validateMovementQuantity} from './kawagoe';
import {assertOutboundEmailReady,sendOutboundEmail,isDefiniteEmailFailure} from './email';
import {splitInventoryRecord,remainingCustomFields} from './splitInventory';
import {nextSplitSku,prepareSplitPhotos,removeUnsentSplitPhotos} from './splitPhotos';
import {preservesOutboundClassification} from './inventoryPolicy';
import {arrivalStatus,isArrivalRow,type OutboundHistoryEntry} from './arrivalTypes';

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
  const waiting=await pendingArrivalInventoryIds();
  const rows=(await all('Inventory',{expression:'attribute_not_exists(deletedAt) AND (contains(categoryIds,:cat) OR (attribute_not_exists(categoryIds) AND categoryId = :cat))',values:{':cat':dest.categoryId}}))
    .filter(row=>!row.outboundBatchId&&!row.outboundArrivalBatchId&&!waiting.has(row.id)&&row.listingPartition!=='MERGED'&&Number(row.quantity)>0);
  const locations=new Map((await all('Location')).map(l=>[l.id,l.name]));
  // Resolve the same signed thumbnails as the staff list, including PhotoStation assets.
  const thumbs=await inventoryThumbnails(rows.map(row=>({...row,...outboundThumbnailFields(row.images)})) as InventoryListRow[]);
  const byId=new Map(thumbs.map(t=>[t.id,t.thumbnailUrl]));
  return rows.map(row=>({id:row.id,sku:row.sku,name:row.name,barcode:row.barcode??'',quantity:row.quantity??0,unit:row.unit??'',updatedAt:row.updatedAt,
    width:row.width??'',depth:row.depth??'',height:row.height??'',location:locations.get(row.locationId)??'',thumbnailUrl:byId.get(row.id)??null}));
}
/** Includes records dispatched before the inventory-side arrival marker existed. */
export async function pendingArrivalInventoryIds(excludeBatchId?:string){
 const ids=new Set<string>();
 for(const record of await all('OutboundItem')){
  const row={...record,snapshot:parseJsonField(record.snapshot,{})} as OutboundRow;
  if(row.batchId!==excludeBatchId&&isArrivalRow(row)&&row.arrivalStatus!=='COMPLETED')ids.add(row.splitInventoryId??row.inventoryId);
 }
 return ids;
}
export async function getOutboundBatch(id:string):Promise<OutboundBatch> {
  requireUuid(id);
  const result=await db.send(new GetCommand({TableName:table('OutboundBatch'),Key:{id},ConsistentRead:true}));
  if(!result.Item)throw new Error('出庫履歴が見つかりません。');
  const rows=(await all('OutboundItem',{expression:'batchId = :id',values:{':id':id}})).map(row=>({...row,snapshot:parseJsonField(row.snapshot,{} as OutboundProduct)}) as OutboundRow);
  return {...result.Item,template:parseJsonField(result.Item.template,DEFAULT_OUTBOUND_COLUMNS),rows:rows.sort((a,b)=>a.snapshot.sku.localeCompare(b.snapshot.sku))} as OutboundBatch;
}
export async function outboundHistory():Promise<OutboundHistoryEntry[]> {
  const [batches,rows]=await Promise.all([all('OutboundBatch'),all('OutboundItem')]);
  const grouped=new Map<string,OutboundRow[]>();
  for(const row of rows){const list=grouped.get(row.batchId)??[];list.push({...row,snapshot:parseJsonField(row.snapshot,{})} as OutboundRow);grouped.set(row.batchId,list);}
  return batches.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(row=>{
    const items=grouped.get(row.id)??[],sent=items.filter(r=>r.status==='SENT'),included=items.filter(r=>r.status==='SENT'||r.status==='PENDING');
    return {id:row.id,destinationName:row.destinationName,createdAt:row.createdAt,dispatchedAt:row.emailSentAt||sent.map(r=>r.sentAt??'').sort().at(-1)||undefined,status:row.status,
      productCount:included.length,quantity:included.reduce((sum,r)=>sum+Number(r.snapshot.quantity),0),arrivalCompletedCount:sent.filter(r=>r.arrivalStatus==='COMPLETED').length,
      arrivalStatus:arrivalStatus({...row,rows:items} as OutboundBatch)};
  });
}
/** The caller supplies one stable command ID. A lost response must reuse it. */
export async function prepareOutbound(id:string,destinationId:string,selected:OutboundSelection[],actor:string,arrivalDate?:string):Promise<OutboundBatch> {
  requireUuid(id);requireUuid(destinationId);
  if(!Array.isArray(selected)||!selected.length||selected.length>200||new Set(selected.map(x=>x.id)).size!==selected.length)throw new Error('1〜200商品を選択してください。');
  selected.forEach(row=>{requireUuid(row.id);if(row.exportName!==undefined&&(typeof row.exportName!=='string'||!row.exportName.trim()||row.exportName.length>500||/[\u0000-\u001f\u007f]/u.test(row.exportName)))throw Error('送信用の商品名は1〜500文字で入力してください。');if(!Number.isFinite(Date.parse(row.updatedAt)))throw new Error('商品を読み直してください。');if(row.quantity!==undefined&&(!Number.isInteger(row.quantity)||row.quantity<1))throw Error('出庫数量は1点以上の整数で入力してください。');if(row.detailNote!==undefined&&(typeof row.detailNote!=='string'||row.detailNote.length>2000))throw Error('入荷明細備考は2000文字以内で入力してください。');});
  const fingerprint=createHash('sha256').update(JSON.stringify([destinationId,[...selected].sort((a,b)=>a.id.localeCompare(b.id)),...(arrivalDate?[arrivalDate]:[])])).digest('hex');
  let batch:OutboundBatch;
  const existing=await db.send(new GetCommand({TableName:table('OutboundBatch'),Key:{id},ConsistentRead:true}));
  if(existing.Item) {
    if(existing.Item.fingerprint!==fingerprint||existing.Item.requestedBy!==actor)throw new Error('同じ処理番号で別の出庫は実行できません。');
    batch=await getOutboundBatch(id);
  } else {
    const dest=await destination(destinationId),now=new Date().toISOString();
    if(dest.preparationStatus==='ON_HOLD')throw new Error('この出庫先の送信データ作成は保留中です。');
    if(dest.preparationStatus!=='READY')throw new Error('送信用テンプレートの準備ができていません。対象商品の確認はできます。');
    if(!['MANUAL','EMAIL'].includes(dest.sender))throw new Error('Slack連携は準備中です。まだ送信できません。');
    const isKawagoe=dest.templateType===KAWAGOE_TEMPLATE;
    if(isKawagoe)validateArrivalDate(arrivalDate);
    const stamp=now.replaceAll(/[-:.TZ]/g,'').slice(0,14);
    const filename=dest.fileNamePattern.replaceAll('{destination}',dest.name).replaceAll('{date}',stamp).replaceAll('{id}',id.slice(0,8)).replace(/[\\/:*?"<>|\r\n]/g,'_');
    const record={id,destinationId,destinationName:dest.name,categoryId:dest.categoryId,locationId:dest.locationId,status:'PREPARING',arrivalWorkflow:'MANUAL_V1',
      ...(isKawagoe?{arrivalDate,templateType:dest.templateType,emailTo:dest.emailTo,emailFrom:dest.emailFrom,emailStatus:'READY'}:{}),
      requestedBy:actor,fingerprint,template:JSON.stringify(dest.template),fileName:filename.endsWith('.csv')?filename:filename+'.csv',sender:dest.sender,createdAt:now,updatedAt:now,__typename:'OutboundBatch'};
    try{if(isKawagoe)await createNumberedBatch(record,arrivalDate!);else await db.send(new PutCommand({TableName:table('OutboundBatch'),Item:record,ConditionExpression:'attribute_not_exists(id)'}));}
    catch(error){const concurrent=await getOutboundBatch(id);if(concurrent.fingerprint!==fingerprint||concurrent.requestedBy!==actor)throw error;}
    batch=await getOutboundBatch(id);
  }
  if(batch.status!=='PREPARING')return batch;
  const recorded=new Set(batch.rows.map(row=>row.inventoryId));
  const waiting=await pendingArrivalInventoryIds(batch.id);
  const locations=new Map((await all('Location')).map(row=>[row.id,row.name]));
  for(const selection of selected) {
    if(recorded.has(selection.id))continue;
    const row=await getInventoryRaw(selection.id),now=new Date().toISOString();
    const sourceQuantity=Number(row?.quantity??0),quantity=selection.quantity??sourceQuantity;
    const snapshot:OutboundProduct={id:selection.id,sku:String(row?.sku??''),name:String(row?.name??'削除された商品'),...(selection.exportName!==undefined?{exportName:selection.exportName.trim()}:{}),barcode:String(row?.barcode??'').trim(),quantity,unit:String(row?.unit??''),updatedAt:selection.updatedAt,location:locations.get(row?.locationId)??'',width:row?.width??'',depth:row?.depth??'',height:row?.height??''};
    let error=!row||row.deletedAt?'商品が削除されています。':row.updatedAt!==selection.updatedAt?'別の端末で変更されています。':!inventoryCategoryIds(row).includes(batch.categoryId)?'移動予定が変更済みです。':row.outboundBatchId||row.outboundArrivalBatchId||waiting.has(selection.id)?'別の出庫で選択済み、または到着確認待ちです。':null;
    if(!error)try{validateMovementQuantity(quantity,sourceQuantity);if(batch.templateType===KAWAGOE_TEMPLATE)validateBarcode(snapshot.barcode);}catch(e){error=(e as Error).message;}
    const item={id:`${id}:${selection.id}`,batchId:id,inventoryId:selection.id,status:error?'SKIPPED':'PENDING',snapshot:JSON.stringify(snapshot),sourceQuantity,detailNote:selection.detailNote??'',...(quantity<sourceQuantity&&!error?{splitInventoryId:randomUUID()}:{}),expectedUpdatedAt:selection.updatedAt,error:error??null,createdAt:now,updatedAt:now,__typename:'OutboundItem'};
    if(error){try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[batchStateCheck(id,'PREPARING'),{Put:{TableName:table('OutboundItem'),Item:item,ConditionExpression:'attribute_not_exists(id)'}}]}));}catch(cause){const fresh=await getOutboundBatch(id);if(fresh.status!=='PREPARING')return fresh;if(!fresh.rows.some(r=>r.id===item.id))throw cause;}continue;}
    try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
      batchStateCheck(id,'PREPARING'),
      {Update:{TableName:table('Inventory'),Key:{id:selection.id},UpdateExpression:'SET outboundBatchId = :batch',ConditionExpression:'updatedAt = :version AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(outboundArrivalBatchId) AND attribute_not_exists(deletedAt)',ExpressionAttributeValues:{':batch':id,':version':selection.updatedAt}}},
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
  // Neither stock counts nor locations change while files are being prepared.
  await updateBatchStatus(id,'AWAITING_SEND',['PREPARING']);
  return getOutboundBatch(id);
}
async function createNumberedBatch(record:Record<string,unknown>,date:string){
 const key=`arrival:${date}`;
 for(let attempt=0;attempt<12;attempt++){
  const current=(await db.send(new GetCommand({TableName:table('OutboundSequence'),Key:{id:key},ConsistentRead:true}))).Item;
  const previous=Number(current?.sequence??0),next=previous+1;
  try{await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
   {Put:{TableName:table('OutboundBatch'),Item:{...record,orderNumber:orderNumber(date,next)},ConditionExpression:'attribute_not_exists(id)'}},
   {Put:{TableName:table('OutboundSequence'),Item:{id:key,sequence:next,createdAt:current?.createdAt??record.createdAt,updatedAt:record.updatedAt,__typename:'OutboundSequence'},ConditionExpression:current?'#n=:old':'attribute_not_exists(id)',...(current?{ExpressionAttributeNames:{'#n':'sequence'},ExpressionAttributeValues:{':old':previous}}:{})}},
  ]}));return;}catch(e){if((await db.send(new GetCommand({TableName:table('OutboundBatch'),Key:{id:record.id},ConsistentRead:true}))).Item)throw e;if((e as Error).name!=='TransactionCanceledException')throw e;}
 }
 throw Error('発注番号の作成が重なりました。もう一度実行してください。');
}

/** One durable send claim, then one transport attempt. Unknown results never auto-resend. */
export async function emailOutbound(batchId:string,actor:string):Promise<OutboundBatch>{
 let batch=await getOutboundBatch(batchId);
 if(batch.sender!=='EMAIL')throw Error('メール送信の設定を確認してください。');
 if(batch.emailStatus==='SENT')return confirmOutboundSent(batchId,actor);
 if(!['AWAITING_SEND'].includes(batch.status))return batch;
 // Validate both complete attachments before acquiring the send claim.
 kawagoeAttachments(batch);await assertOutboundEmailReady(batch);
 if(!await updateBatchStatus(batchId,'SENDING',['AWAITING_SEND']))return getOutboundBatch(batchId);
 try{
  for(const item of batch.rows.filter(row=>row.status==='PENDING'&&row.splitInventoryId&&!row.splitPrepared)){
   const source=await getInventoryRaw(item.inventoryId);
   if(!source||source.outboundBatchId!==batchId||source.updatedAt!==item.expectedUpdatedAt)throw Error('出庫対象が変更されています。送信前に確認してください。');
   await prepareSplit(source,item);
  }
  batch=await getOutboundBatch(batchId);
  for(const item of batch.rows.filter(row=>row.status==='PENDING')){
   const source=await getInventoryRaw(item.inventoryId);
   if(!source||source.deletedAt||source.outboundBatchId!==batchId||source.updatedAt!==item.expectedUpdatedAt||Number(source.quantity)!==item.sourceQuantity||!inventoryCategoryIds(source).includes(batch.categoryId))throw Error('出庫対象が変更されています。未送信データを取り消して選び直してください。');
  }
 }catch(e){await updateBatchStatus(batchId,'AWAITING_SEND',['SENDING']);throw e;}
 let messageId:string;
 try{messageId=await sendOutboundEmail(batch);}catch(e){
  console.error('[outbound-email]',{batchId,name:(e as Error).name,message:(e as Error).message});
  const definite=isDefiniteEmailFailure(e);
  await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id:batchId},UpdateExpression:'SET #s=:s, emailStatus=:mail, emailError=:error',ConditionExpression:'#s=:sending',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':definite?'AWAITING_SEND':'SEND_UNKNOWN',':sending':'SENDING',':mail':definite?'FAILED':'UNKNOWN',':error':definite?'メールを送信できませんでした。送信設定を確認して再試行してください。':'メールの送信結果を確認できません。重複防止のため自動再送を止めています。受信メールを確認してください。'}}));
  return getOutboundBatch(batchId);
 }
 // Persist transport acceptance before inventory updates. A retry only resumes updates.
 await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id:batchId},UpdateExpression:'SET emailStatus=:sent, emailMessageId=:id, emailSentAt=:now',ConditionExpression:'#s=:sending',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':sent':'SENT',':id':messageId,':now':new Date().toISOString(),':sending':'SENDING'}}));
 return confirmOutboundSent(batchId,actor);
}
/** Human receipt confirmation resolves an uncertain transport result without resending. */
export async function acknowledgeOutboundReceipt(batchId:string,actor:string){
 const batch=await getOutboundBatch(batchId);
 if(batch.sender!=='EMAIL')throw Error('メール送信の履歴ではありません。');
 if(batch.emailStatus==='SENT')return confirmOutboundSent(batchId,actor);
 const expired=batch.status==='SENDING'&&Date.parse(batch.updatedAt??batch.createdAt)<Date.now()-5*60*1000;
 if(batch.status!=='SEND_UNKNOWN'&&!expired)throw Error('送信処理中です。5分ほど待って結果を再確認してください。');
 await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id:batchId},UpdateExpression:'SET #s=:sending, emailStatus=:sent, emailConfirmedBy=:who, emailConfirmedAt=:now REMOVE emailError',ConditionExpression:'#s=:old AND updatedAt=:version',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':sending':'SENDING',':sent':'SENT',':who':actor,':now':new Date().toISOString(),':old':batch.status,':version':batch.updatedAt}}));
 return confirmOutboundSent(batchId,actor);
}
function batchStateCheck(id:string,status:string){return {ConditionCheck:{TableName:table('OutboundBatch'),Key:{id},ConditionExpression:'#s = :s',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':status}}};}
async function updateBatchStatus(id:string,status:string,from:string[]) {
  try{await db.send(new UpdateCommand({TableName:table('OutboundBatch'),Key:{id},UpdateExpression:'SET #s = :s, updatedAt = :now',ConditionExpression:'#s IN ('+from.map((_,i)=>`:f${i}`).join(',')+')',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':status,':now':new Date().toISOString(),...Object.fromEntries(from.map((s,i)=>[`:f${i}`,s]))}}));return true;}
  catch(e){if(e instanceof Error&&e.name==='ConditionalCheckFailedException')return false;throw e;}
}
async function prepareSplit(source:Record<string,unknown>,item:OutboundRow){
 const splitSku=item.splitSku??await nextSplitSku();
 await db.send(new UpdateCommand({TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET splitSku=:sku',ExpressionAttributeValues:{':sku':splitSku}}));
 const images=await prepareSplitPhotos(source,item);
 await db.send(new UpdateCommand({TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET splitImages=:photos, splitPrepared=:yes',ExpressionAttributeValues:{':photos':JSON.stringify(images),':yes':true}}));
 Object.assign(item,{splitSku,splitImages:images,splitPrepared:true});
}
export async function confirmOutboundSent(batchId:string,actor:string):Promise<OutboundBatch> {
  const batch=await getOutboundBatch(batchId);
  if(batch.status==='CANCELLED'||batch.status==='CANCELLING')throw new Error('この出庫データは取り消されています。');
  if(batch.status==='PREPARING')throw new Error('データを作成中です。もう一度結果を確認してください。');
  if(batch.sender!=='MANUAL'&&!(batch.sender==='EMAIL'&&batch.emailStatus==='SENT'))throw new Error('メール送信の完了を確認してから出庫を完了します。');
  if(batch.status==='COMPLETED')return batch;
  if(!await updateBatchStatus(batchId,'APPLYING',['AWAITING_SEND','PARTIAL','APPLYING','SENDING']))throw new Error('出庫の状態が変わりました。履歴を確認してください。');
  for(const item of batch.rows.filter(row=>row.status==='PENDING')) {
    const row=await getInventoryRaw(item.inventoryId);
    if(!row||row.outboundBatchId!==batchId||row.updatedAt!==item.expectedUpdatedAt){await recordPendingError(item.id,'対象商品が更新されています。送信内容と履歴を確認してください。自動再送は行いません。');continue;}
    if(!item.splitInventoryId){
      try{
        // Dispatch only records the reservation. Classification changes require arrival confirmation.
        const now=new Date(Math.max(Date.now(),Date.parse(row.updatedAt)+1)).toISOString();
        const after=inventoryCategoryIds(row);
        await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
          batchStateCheck(batchId,'APPLYING'),
          {Update:{TableName:table('Inventory'),Key:{id:item.inventoryId},UpdateExpression:'SET outboundArrivalBatchId=:batch, updatedAt=:now, listUpdatedAt=:now, updatedBy=:who REMOVE outboundBatchId',ConditionExpression:'outboundBatchId=:batch AND updatedAt=:version AND attribute_not_exists(deletedAt)',ExpressionAttributeValues:{':batch':batchId,':version':item.expectedUpdatedAt,':now':now,':who':actor}}},
          {Update:{TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET #s=:sent, sentAt=:now, sentBy=:who, updatedAt=:now, #snapshot=:snapshot REMOVE #error, splitInventoryId, splitSku, splitImages, splitPrepared',ConditionExpression:'#s=:pending',ExpressionAttributeNames:{'#s':'status','#error':'error','#snapshot':'snapshot'},ExpressionAttributeValues:{':sent':'SENT',':pending':'PENDING',':now':now,':who':actor,':snapshot':JSON.stringify({...item.snapshot,classificationPreserved:true,movementCategoryRemoved:false})}}},
          {Put:{TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId:item.inventoryId,changedAt:now,changedBy:actor,fieldName:'出庫データ送信',oldValue:JSON.stringify({categoryIds:after,locationId:row.locationId,quantity:row.quantity}),newValue:JSON.stringify({categoryIds:after,locationId:row.locationId,quantity:row.quantity,batchId,destination:batch.destinationName,sentQuantity:item.snapshot.quantity,classificationPreserved:true,movementCategoryRemoved:false}),createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}},
        ]}));
      }catch(error){
        const fresh=await db.send(new GetCommand({TableName:table('OutboundItem'),Key:{id:item.id},ConsistentRead:true}));
        if(fresh.Item?.status!=='SENT'){console.error('[outbound-record]',error);await recordPendingError(item.id,'出庫履歴の保存を確認できません。結果を再確認してください。商品情報は変更していません。');}
      }
      continue;
    }
    const now=new Date(Math.max(Date.now(),Date.parse(row.updatedAt)+1)).toISOString(),after=inventoryCategoryIds(row);
    if(item.splitInventoryId){
      try{
        validateMovementQuantity(item.snapshot.quantity,Number(row.quantity));
        if(item.snapshot.quantity>=Number(row.quantity))throw Error('分割する在庫数が変わっています。');
        if(!item.splitPrepared)await prepareSplit(row,item);
        const child=splitInventoryRecord(row,item,batch,after,actor,now),remaining=Number(row.quantity)-item.snapshot.quantity;
        await sendOutboundTransaction(db,new TransactWriteCommand({TransactItems:[
          batchStateCheck(batchId,'APPLYING'),
          {Update:{TableName:table('Inventory'),Key:{id:item.inventoryId},UpdateExpression:'SET quantity=:qty, customFields=:custom, updatedAt=:now, listUpdatedAt=:now, updatedBy=:who REMOVE outboundBatchId',ConditionExpression:'outboundBatchId=:batch AND updatedAt=:version AND quantity=:available AND attribute_not_exists(deletedAt)',ExpressionAttributeValues:{':qty':remaining,':custom':remainingCustomFields(row,remaining),':now':now,':who':actor,':batch':batchId,':version':item.expectedUpdatedAt,':available':Number(row.quantity)}}},
          {Put:{TableName:table('Inventory'),Item:child,ConditionExpression:'attribute_not_exists(id)'}},
          ...categoryLinkChanges(child.id,[],after,now),
          {Update:{TableName:table('OutboundItem'),Key:{id:item.id},UpdateExpression:'SET #s=:sent, sentAt=:now, sentBy=:who, #snapshot=:snapshot REMOVE #error',ConditionExpression:'#s=:pending',ExpressionAttributeNames:{'#s':'status','#error':'error','#snapshot':'snapshot'},ExpressionAttributeValues:{':sent':'SENT',':pending':'PENDING',':now':now,':who':actor,':snapshot':JSON.stringify({...item.snapshot,classificationPreserved:preservesOutboundClassification(batch),movementCategoryRemoved:false})}}},
          ...[item.inventoryId,child.id].map(inventoryId=>({Put:{TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId,changedAt:now,changedBy:actor,fieldName:'部分出庫',oldValue:JSON.stringify({quantity:row.quantity,locationId:row.locationId}),newValue:JSON.stringify({batchId,sourceInventoryId:item.inventoryId,movedInventoryId:child.id,movedQuantity:child.quantity,remainingQuantity:remaining,locationId:child.locationId,categoryIds:after}),createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}})),
        ]}));
      }catch(e){const fresh=await getOutboundBatch(batchId);if(fresh.rows.find(r=>r.id===item.id)?.status!=='SENT')await recordPendingError(item.id,'移動分の商品ページの保存を確認できません。更新結果を再確認してください。');}
      continue;
    }
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
  if(batch.rows.some(row=>row.splitInventoryId))await removeUnsentSplitPhotos(batchId);
  await updateBatchStatus(batchId,'CANCELLED',['CANCELLING']);return getOutboundBatch(batchId);
}
async function recordPendingError(id:string,message:string){try{await db.send(new UpdateCommand({TableName:table('OutboundItem'),Key:{id},UpdateExpression:'SET #e=:e',ConditionExpression:'#s=:p',ExpressionAttributeNames:{'#s':'status','#e':'error'},ExpressionAttributeValues:{':p':'PENDING',':e':message}}));}catch(e){if(!(e instanceof Error)||e.name!=='ConditionalCheckFailedException')throw e;}}

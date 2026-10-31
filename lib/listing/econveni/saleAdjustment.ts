import 'server-only';
import {randomUUID} from 'node:crypto';
import {GetCommand,PutCommand,TransactWriteCommand,type TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import {econveniDatabase as db,ECONVENI_WORKFLOW_TABLE as table,econveniStore} from './runtimeStore';
import {EconveniHttpSession} from './httpSession';
import {withEconveniAccount} from './accountWorkflow';
import {econveniCredentialStore} from './credentials';
import {econveniFailure} from './service';
import {getInventoryRaw,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {stockCountTitle} from '@/lib/inventory/stockCountTitle';
import {getChannelListing} from '../service';
import {readBaseItem,claimBaseManual,finishBaseManual} from '../base/manualLifecycle';
import {setManualBaseStock} from '../base/adapter';
import {adjustmentFingerprint,adjustmentKey,runSaleAdjustment,type SaleAdjustment,type AdjustmentReceipt} from './saleAdjustmentCore';
import type {ExternalProduct,ExternalSnapshot,ManualLink} from './manualSyncModel';
export async function saleAdjustmentStarted(request:SaleAdjustment){return !!(await db.send(new GetCommand({TableName:table,Key:{pk:adjustmentKey(request)},ConsistentRead:true}))).Item;}

async function binding(id:string){
 const [item,linkResult,workflow]=await Promise.all([getInventoryRaw(id),db.send(new GetCommand({TableName:table,Key:{pk:'ECONVENI#MANUAL_LINK#'+id},ConsistentRead:true})),econveniStore(id).read()]);
 const saved=linkResult.Item as ManualLink|undefined,link=saved&&!saved.disabled?saved:null;
 if(!item||item.isDeleted||item.deletedAt)throw Error('在庫を確認できません。');
 const productId=link?.productId??workflow?.save.productId;
 if(!productId)return null;
 if(link&&workflow?.save.productId&&link.productId!==workflow.save.productId)throw Error('eコンビニの紐付けが一致しません。');
 if(workflow&&(['PENDING','VERIFY_REQUIRED'].includes(workflow.save.state)||Object.values(workflow.channels).some(c=>['PENDING','VERIFY_REQUIRED'].includes(c.state))))throw Error('eコンビニの前回の処理結果を先に確認してください。');
 const version=adjustmentFingerprint([productId,link?.revision??null,workflow?.revision??null]);
 const checks:NonNullable<TransactWriteCommandInput['TransactItems']>=[{ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id},ConditionExpression:'updatedAt=:v AND (attribute_not_exists(isDeleted) OR isDeleted=:no)',ExpressionAttributeValues:{':v':item.updatedAt,':no':false}}}];
 if(link){checks.push({ConditionCheck:{TableName:table,Key:{pk:'ECONVENI#MANUAL_LINK#'+id},ConditionExpression:'revision=:r AND productId=:p AND (attribute_not_exists(disabled) OR disabled=:no)',ExpressionAttributeValues:{':r':link.revision,':p':productId,':no':false}}},{ConditionCheck:{TableName:table,Key:{pk:'ECONVENI#MANUAL_OWNER#'+productId},ConditionExpression:'inventoryId=:id',ExpressionAttributeValues:{':id':id}}});}
 if(workflow)checks.push({ConditionCheck:{TableName:table,Key:{pk:workflow.pk},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':workflow.revision}}});
 return {item,link,workflow,productId,version,checks};
}
async function remember(remote:ExternalProduct){
 const key={pk:'ECONVENI#OBSERVED_CATALOG'},old=(await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}))).Item as ExternalSnapshot|undefined;
 const value={...key,version:randomUUID(),checkedAt:new Date().toISOString(),products:[...(old?.products??[]).filter(p=>p.productId!==remote.productId),remote]};
 // Do not claim that all cached products were checked now. Their snapshot time remains unchanged.
 if(old)value.checkedAt=old.checkedAt;
 await db.send(new PutCommand({TableName:table,Item:value,ConditionExpression:old?'#v=:v':'attribute_not_exists(pk)',...(old?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}:{})}));
}
/** Focused live read before a sale confirmation. No name-based automatic linking or full-catalog polling. */
export async function refreshSaleBinding(id:string):Promise<ExternalProduct|null>{
 const b=await binding(id);if(!b)return null;
 const session=new EconveniHttpSession();
 return withEconveniAccount(econveniStore(id),session,()=>econveniCredentialStore.credentials(),async()=>{
  const remote=await session.readExternalProduct(b.productId);
  if(remote.inventoryMarker&&remote.inventoryMarker!==id)throw Error('eコンビニに別の在庫番号が登録されています。');
  for(const channel of ['BASE','YAHOO','MERCARI_SHOPS'] as const){
   const expected=b.link?.baseline[channel].listingId??(channel==='BASE'?null:b.workflow?.channels[channel].listingId);
   if(expected&&remote.channels[channel].listingId&&expected!==remote.channels[channel].listingId)throw Error('出品IDが変わっています。eコンビニ連携で写真と商品を確認してください。');
  }
  await remember(remote);return remote;
 });
}
export async function reviewSaleAdjustment(input:{candidateId:string;inventoryId:string;channel:'BASE'|'YAHOO';listingId:string;remaining:number;pack:number;inventoryVersion:string}):Promise<SaleAdjustment|null>{
 const b=await binding(input.inventoryId);if(!b)return null;
 const session=new EconveniHttpSession();
 return withEconveniAccount(econveniStore(input.inventoryId),session,()=>econveniCredentialStore.credentials(),async()=>{
  const remote=await session.readExternalProduct(b.productId),{values}=await session.saleProductFields(b.productId);
  if(b.item.updatedAt!==input.inventoryVersion||remote.channels[input.channel].listingId!==input.listingId||remote.inventoryMarker&&remote.inventoryMarker!==input.inventoryId)throw Error('紐付けまたは在庫情報が変わりました。');
  const native=input.channel==='BASE'?await getChannelListing(input.inventoryId,'BASE'):null;
  if(native?.externalListingId&&native.externalListingId!==input.listingId||native?.status==='PUBLISHING')throw Error('BASEの紐付けまたは処理中の操作を確認してください。');
  const actual=input.channel==='BASE'?await readBaseItem(input.listingId):null;
  if(actual?.hasVariations)throw Error('バリエーション別の数量はBASEで変更してください。');
  const quantity=input.channel==='BASE'?Math.min(actual!.quantity,Math.floor(input.remaining/input.pack)):Math.floor(input.remaining/input.pack);
  if(input.channel==='YAHOO'&&quantity<1)throw Error('残り在庫が1出品分に足りません。');
  const fields:Record<string,string>={products_name:stockCountTitle(values.products_name,input.remaining),products_quantity:String(input.remaining)};
  if(input.channel==='BASE'){fields.base_stock=String(quantity);fields.base_title=stockCountTitle(values.base_title,input.remaining);}
  else fields.products_quantity=String(quantity);
  if(Object.keys(fields).some(k=>typeof values[k]!=='string'))throw Error('eコンビニの入力項目を確認できません。');
  const beforeFields=Object.fromEntries(Object.keys(fields).map(k=>[k,values[k]]));
  const beforeTitle=actual?.title??remote.title,title=stockCountTitle(beforeTitle,input.remaining);
  const data={candidateId:input.candidateId,inventoryId:input.inventoryId,inventoryVersion:input.inventoryVersion,productId:b.productId,bindingVersion:b.version,channel:input.channel,listingId:input.listingId,price:remote.price,quantity,beforeQuantity:actual?.quantity??remote.quantity,title,beforeTitle,fields,beforeFields};
  return {...data,fingerprint:adjustmentFingerprint(data)};
 });
}
export async function executeSaleAdjustment(request:SaleAdjustment){
 const store=econveniStore(request.inventoryId),session=new EconveniHttpSession();
 try{return await withEconveniAccount(store,session,()=>econveniCredentialStore.credentials(),async()=>{
  const b=await binding(request.inventoryId);if(!b)throw Error('紐付けがありません。');
  return runSaleAdjustment(request,{
   read:async()=>((await db.send(new GetCommand({TableName:table,Key:{pk:adjustmentKey(request)},ConsistentRead:true}))).Item as AdjustmentReceipt)??null,
   checkBinding:async()=>{if(b.productId!==request.productId||b.version!==request.bindingVersion||b.item.updatedAt!==request.inventoryVersion)throw Error('紐付けまたは在庫が変更されています。');},
   observe:async(r,step)=>{
    const remote=await session.readExternalProduct(r.productId),id=remote.channels[r.channel].listingId;
    if(remote.inventoryMarker&&remote.inventoryMarker!==r.inventoryId)throw Error('在庫番号が変わりました。');
    if(step==='CLEAR')return {done:id===null&&remote.channels.YAHOO.state==='INACTIVE',safe:id===r.listingId};
    if(step==='PUBLISH')return {done:!!id&&id!==r.listingId&&remote.channels.YAHOO.state==='ACTIVE',safe:!id&&remote.channels.YAHOO.state==='INACTIVE',newListingId:id??undefined,newListingUrl:remote.channels.YAHOO.listingUrl??undefined};
    if(r.channel==='BASE'&&id!==r.listingId||r.channel==='YAHOO'&&id!==null)throw Error('対象の出品IDが変わりました。');
    if(step==='EDIT'){const {values}=await session.saleProductFields(r.productId);return {done:Object.entries(r.fields).every(([k,v])=>values[k]===v),safe:Object.entries(r.beforeFields).every(([k,v])=>values[k]===v||values[k]===r.fields[k])};}
    const base=await readBaseItem(r.listingId);
    return {done:!base.hasVariations&&base.quantity===r.quantity&&base.title===r.title,safe:!base.hasVariations&&base.quantity===r.beforeQuantity&&base.title===r.beforeTitle};
   },
   commit:(old,next,reserve)=>store.commitSaleAdjustment(old,next,b.checks,reserve),
   send:async(r,step)=>{
    if(step==='CLEAR'){await session.clearSoldYahooId(r.productId,r.listingId);return;}
    if(step==='EDIT'){const {values}=await session.saleProductFields(r.productId);if(!Object.entries(r.beforeFields).every(([k,v])=>values[k]===v||values[k]===r.fields[k]))throw Error('保存直前に商品情報が変わりました。');await session.updateSaleFields(r.productId,Object.fromEntries(Object.keys(r.fields).map(k=>[k,values[k]])),r.fields);return;}
    if(step==='STOCK'){
     const native=await getChannelListing(r.inventoryId,'BASE');
     if(native&&native.externalListingId!==r.listingId)throw Error('BASEの紐付けが変わりました。');
     const lock=native?await claimBaseManual(native):null;
     try{try{await setManualBaseStock(r.listingId,r.quantity,r.title);}catch{/* Read back a possibly successful request; never resend. */}const actual=await readBaseItem(r.listingId);if(actual.quantity!==r.quantity||actual.title!==r.title)throw Error('BASEの更新を確認できません。');if(native&&lock)await finishBaseManual(native,lock,{status:actual.visible?'ACTIVE':'PAUSED'});}
     catch(e){if(native&&lock)await finishBaseManual(native,lock,{status:'ERROR',lastError:'売却後の数量を確認してください。'}).catch(()=>{});throw e;}return;
    }
    const remote=await session.readExternalProduct(r.productId);
    if(remote.channels.YAHOO.listingId||remote.channels.YAHOO.state!=='INACTIVE')throw Error('古い出品IDが残っています。');
    const {values}=await session.saleProductFields(r.productId);if(remote.price!==r.price||!Object.entries(r.fields).every(([k,v])=>values[k]===v))throw Error('出品前に金額・数量・商品名が変更されています。');
    const command=await session.publicationPreview({channel:'YAHOO',operation:'PUBLISH',productId:r.productId,title:r.fields.products_name,price:r.price});
    await session.executeCommand(command);
   },
   finish:async(receipt)=>{
    const remote=await session.readExternalProduct(request.productId),now=new Date().toISOString();
    const writes:NonNullable<TransactWriteCommandInput['TransactItems']>=[];
    if(request.channel==='YAHOO'){
     if(!receipt.newListingId||remote.channels.YAHOO.listingId!==receipt.newListingId)throw Error('新しい出品IDを確認できません。');
     if(b.link)writes.push({Put:{TableName:table,Item:{pk:'ECONVENI#MANUAL_LINK#'+request.inventoryId,...b.link,baseline:{...b.link.baseline,YAHOO:remote.channels.YAHOO},revision:b.link.revision+1},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':b.link.revision}}});
     if(b.workflow)writes.push({Put:{TableName:table,Item:{...b.workflow,revision:b.workflow.revision+1,updatedAt:now,approvals:{},channels:{...b.workflow.channels,YAHOO:{state:'SUCCEEDED',operation:'PUBLISH',remoteStatus:'ACTIVE',listingId:receipt.newListingId,listingUrl:receipt.newListingUrl,publishedAt:now}}},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':b.workflow.revision}}});
    }
    const changed=new Set(writes.map(w=>w.Put?.Item?.pk));
    await db.send(new TransactWriteCommand({TransactItems:[...b.checks.filter(c=>!changed.has(c.ConditionCheck?.Key?.pk)),...writes,{Put:{TableName:table,Item:{...receipt,complete:true,revision:receipt.revision+1,updatedAt:now},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':receipt.revision}}}]}));
    await remember(remote).catch(()=>{});
   },
  });
 });}catch(e){return econveniFailure(e);}
}

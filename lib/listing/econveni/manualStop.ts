import 'server-only';
import {GetCommand,ScanCommand,type ScanCommandInput} from '@aws-sdk/lib-dynamodb';
import {econveniDatabase as db,ECONVENI_WORKFLOW_TABLE as table,econveniStore} from './runtimeStore';
import {EconveniHttpSession,econveniCommandCompleted,type EconveniCommand} from './httpSession';
import {econveniCredentialStore} from './credentials';
import {withEconveniAccount} from './accountWorkflow';
import {getInventoryRaw,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {getChannelListing} from '../service';
import {readBaseItem} from '../base/manualLifecycle';
import {setManualBaseVisibility} from '../base/adapter';
import {econveniFailure} from './service';
import type {ManualLink,ExternalSnapshot,ManualSyncData,ExternalProduct} from './manualSyncModel';
import type {EcChannel,EcReview,EcCatalog} from '../ecManagement';
import {runManualStop,stopReceiptKey,stopFingerprint,type StopReceipt} from './manualStopCore';

/** Dedicated STOP-only path for human-approved existing-product links. No product registration or publishing. */
export async function manualLinkedStop(id:string,channel:EcChannel,actor:string,token?:string,preflight?:{session:EconveniHttpSession;remote:ExternalProduct}):Promise<EcReview|null>{
 // Internal read-only batch context. An execution token must always acquire its own lease and read afresh.
 if(preflight&&token)throw Error('PREFLIGHT_ONLY');
 const link=(await db.send(new GetCommand({TableName:table,Key:{pk:'ECONVENI#MANUAL_LINK#'+id},ConsistentRead:true}))).Item as ManualLink|undefined;
 if(!link||link.disabled)return token?.startsWith('MSTOP.')?{inventoryId:id,channel,operation:'STOP',title:'',status:'BLOCKED',message:'紐付けが解除されています。確認し直してください。'}:null;
 const base:EcReview={inventoryId:id,channel,operation:'STOP',title:link.inventoryName,status:'BLOCKED',message:'出品番号と紐付けを確認できません。再取得してください。'};
 if(!actor)return {...base,message:'ログイン状態を確認してください。'};
 try{
  const [item,snapshot]=await Promise.all([getInventoryRaw(id),db.send(new GetCommand({TableName:table,Key:{pk:'ECONVENI#OBSERVED_CATALOG'},ConsistentRead:true}))]);
  if(!item||item.isDeleted||item.deletedAt)return base;
  const cached=preflight?.remote.channels[channel]??(snapshot.Item as ExternalSnapshot|undefined)?.products.find(p=>p.productId===link.productId)?.channels[channel];
  const listingId=cached?.listingId??link.baseline[channel].listingId;
  // Never silently accept a replacement listing ID from a refreshed catalog.
  if(!listingId||link.baseline[channel].listingId&&listingId!==link.baseline[channel].listingId)return base;
  const [workflow,native]=await Promise.all([econveniStore(id).read(),channel==='YAHOO'?Promise.resolve(null):getChannelListing(id,channel)]);
  if(workflow?.save.productId&&workflow.save.productId!==link.productId||native?.externalListingId&&native.externalListingId!==listingId)return base;
  // Existing native bindings keep their existing per-listing locks and confirmation path.
  if(!token?.startsWith('MSTOP.')&&(channel==='BASE'&&native?.externalListingId===listingId||channel!=='BASE'&&workflow?.save.productId===link.productId&&workflow.channels[channel].listingId===listingId))return null;
  if(workflow&&(['PENDING','VERIFY_REQUIRED'].includes(workflow.save.state)||Object.values(workflow.channels).some(c=>['PENDING','VERIFY_REQUIRED'].includes(c.state)))||native?.status==='PUBLISHING')return {...base,message:'別の処理の結果が未確認です。先に結果を確認してください。'};
  const store=econveniStore(id),session=preflight?.session??new EconveniHttpSession();
  if(preflight&&preflight.remote.productId!==link.productId)return base;
  const binding={inventoryId:id,productId:link.productId,linkRevision:link.revision,inventoryVersion:item.updatedAt,title:String(item.name),listingId};
  const checks=[
   {ConditionCheck:{TableName:table,Key:{pk:'ECONVENI#MANUAL_LINK#'+id},ConditionExpression:'revision=:r AND productId=:p AND (attribute_not_exists(disabled) OR disabled=:no)',ExpressionAttributeValues:{':r':link.revision,':p':link.productId,':no':false}}},
   {ConditionCheck:{TableName:table,Key:{pk:'ECONVENI#MANUAL_OWNER#'+link.productId},ConditionExpression:'inventoryId=:id',ExpressionAttributeValues:{':id':id}}},
   {ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id},ConditionExpression:'updatedAt=:v AND (attribute_not_exists(isDeleted) OR isDeleted=:no)',ExpressionAttributeValues:{':v':item.updatedAt,':no':false}}},
  ];
  let command:EconveniCommand|undefined;
  const review=()=>runManualStop(binding,channel,actor,{
   read:async()=>((await db.send(new GetCommand({TableName:table,Key:{pk:stopReceiptKey(id,channel)},ConsistentRead:true}))).Item as StopReceipt)??null,
   observe:async receipt=>{
    const remote=preflight?.remote??await session.readExternalProduct(link.productId),state=remote.channels[channel];
    if(remote.inventoryMarker&&remote.inventoryMarker!==id)throw Error('BINDING_CHANGED');
    if(channel==='BASE'){
     if(state.listingId!==listingId&&!(state.state==='INACTIVE'&&!state.listingId))throw Error('LISTING_CHANGED');
     const actual=await readBaseItem(listingId);
     // A removed link may prove an already-private BASE item, but can never authorize a write.
     if(actual.visible&&state.listingId!==listingId)throw Error('LISTING_CHANGED');
     return {listingId:actual.id,active:actual.visible,stopped:!actual.visible,title:actual.title,fingerprint:stopFingerprint([link.revision,remote.productId,actual.id,actual.title,actual.price,actual.quantity,actual.visible])};
    }
    return {listingId:state.listingId,active:state.state==='ACTIVE',stopped:state.state==='INACTIVE'&&(state.listingId===listingId||!!receipt?.acknowledged&&!state.listingId),title:remote.title,fingerprint:stopFingerprint([link.revision,remote.productId,remote.title,remote.price,remote.quantity,state])};
   },
   preview:async()=>{if(channel!=='BASE')command=await session.manualStopPreview(link.productId,channel);},
   send:async()=>{if(channel==='BASE'){await setManualBaseVisibility(listingId,false);return true;}if(!command)throw Error('NO_PREVIEW');return econveniCommandCompleted(await session.executeCommand(command),channel,'STOP');},
   commit:(old,next,reserve)=>store.commitManualStop(old,next,checks,reserve),
  },token?.startsWith('MSTOP.')?token.slice(6):token);
  const result=preflight?await review():await withEconveniAccount(store,session,()=>econveniCredentialStore.credentials(),review);
  return {...result,token:result.token?'MSTOP.'+result.token:undefined};
 }catch(e){
  if(preflight&&['AUTH_REQUIRED','ACCESS_DENIED','ADDITIONAL_AUTH'].includes(String((e as {code?:string}).code)))throw e;
  return {...base,...econveniFailure(e),token};
 }
}

/** Verified commands override the older read-only observation, without becoming a publish binding. */
export async function overlayManualStops(catalog:EcCatalog,manual:ManualSyncData,inventoryId?:string){
 let cursor:ScanCommandInput['ExclusiveStartKey'];
 do{
  const r=inventoryId?{Items:(await Promise.all((['BASE','MERCARI_SHOPS','YAHOO'] as const).map(channel=>db.send(new GetCommand({TableName:table,Key:{pk:stopReceiptKey(inventoryId,channel)},ConsistentRead:true}))))).flatMap(result=>result.Item?[result.Item]:[]),LastEvaluatedKey:undefined}:await db.send(new ScanCommand({TableName:table,ExclusiveStartKey:cursor,ConsistentRead:true,FilterExpression:'begins_with(pk,:p)',ExpressionAttributeValues:{':p':'ECONVENI#MANUAL_STOP#'}}));
  for(const receipt of (r.Items??[]) as StopReceipt[]){
   if(receipt.state==='READY')continue;
   const link=manual.links.find(l=>!l.disabled&&l.inventoryId===receipt.inventoryId);
   if(!link||link.productId!==receipt.productId||link.revision!==receipt.linkRevision)continue;
   const own=catalog.channels[receipt.channel]?.[receipt.inventoryId];
   if(!own||own.externalId!==receipt.listingId||own.source!=='ECONVENI'&&own.checkedAt&&own.checkedAt>receipt.updatedAt)continue;
   catalog.channels[receipt.channel]![receipt.inventoryId]={...own,state:receipt.state==='DONE'?'STOPPED':'ERROR',checkedAt:receipt.updatedAt,note:receipt.state==='DONE'?'出品停止を確認済みです。':'停止結果の確認が必要です。重複送信はしません。'};
  }
  cursor=r.LastEvaluatedKey;
 }while(cursor);
}

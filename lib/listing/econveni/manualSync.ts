import 'server-only';
import {randomUUID,createHash} from 'node:crypto';
import {GetCommand,PutCommand,ScanCommand,TransactWriteCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {econveniDatabase as db,ECONVENI_WORKFLOW_TABLE as table,econveniStore,readEconveniCatalog} from './runtimeStore';
import {EconveniHttpSession} from './httpSession';
import {econveniCredentialStore} from './credentials';
import {withEconveniAccount} from './accountWorkflow';
import {getInventoryRaw,inventoryTable} from '@/lib/inventory/categoryPersistence';
import type {ExternalProduct,ExternalSnapshot,ManualLink,ManualSyncData} from './manualSyncModel';

const cacheKey={pk:'ECONVENI#OBSERVED_CATALOG'};
const linkKey=(id:string)=>({pk:'ECONVENI#MANUAL_LINK#'+id});
const ownerKey=(id:string)=>({pk:'ECONVENI#MANUAL_OWNER#'+id});
export const productFingerprint=(p:ExternalProduct)=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
export async function readManualSync():Promise<ManualSyncData>{
 const snapshot=(await db.send(new GetCommand({TableName:table,Key:cacheKey,ConsistentRead:true}))).Item as ExternalSnapshot|undefined;
 const links:ManualLink[]=[];let cursor:Record<string,unknown>|undefined;
 do{const result=await db.send(new ScanCommand({TableName:table,FilterExpression:'begins_with(pk,:prefix)',ExpressionAttributeValues:{':prefix':'ECONVENI#MANUAL_LINK#'},ExclusiveStartKey:cursor,ConsistentRead:true}));links.push(...(result.Items??[]) as ManualLink[]);cursor=result.LastEvaluatedKey;if(links.length>20000)throw Error('LINK_LIMIT');}while(cursor);
 return {snapshot:snapshot??null,links:links.filter(x=>!x.disabled)};
}
/** User-triggered only; at most once per minute per account, including failed attempts. */
export async function refreshManualSync():Promise<ManualSyncData>{
 const now=Date.now();
 try{await db.send(new UpdateCommand({TableName:table,Key:{pk:'ECONVENI#MANUAL_READ_LIMIT'},UpdateExpression:'SET nextAt=:next',ConditionExpression:'attribute_not_exists(nextAt) OR nextAt<=:now',ExpressionAttributeValues:{':now':now,':next':now+60000}}));}
 catch{throw Error('状態取得は1分以上間隔を空けてください。');}
 const lease=econveniStore('manual-status-reader'),session=new EconveniHttpSession();
 return withEconveniAccount(lease,session,()=>econveniCredentialStore.credentials(),async()=>{
  const products=await session.readExternalCatalog();
  const snapshot:ExternalSnapshot={version:randomUUID(),checkedAt:new Date().toISOString(),products};
  // Single atomic snapshot. A partial page/error never changes the previous observations.
  if(Buffer.byteLength(JSON.stringify(snapshot))>350000)throw Error('商品情報が取得上限を超えました。前回の状態を維持しています。');
  await db.send(new PutCommand({TableName:table,Item:{...cacheKey,...snapshot}}));
  return readManualSync();
 });
}
/** The user confirms photos + title. A unique owner and version conditions prevent ambiguous/repeated binding. */
export async function linkExternalProduct(input:{inventoryId:string;productId:string;version:string;fingerprint:string;confirmed:boolean},actor:string,allowCompletedSale=false){
 if(!input.confirmed||!/^\d{1,15}$/.test(input.productId))throw Error('商品名と写真を確認してください。');
 const [data,item,workflows]=await Promise.all([readManualSync(),getInventoryRaw(input.inventoryId),readEconveniCatalog()]);
 if(!item||item.isDeleted||item.deletedAt||item.quantity<1||item.saleEndDate&&!allowCompletedSale)throw Error('現在の在庫を確認してください。');
 const snapshot=data.snapshot,remote=snapshot?.products.find(p=>p.productId===input.productId);
 if(!snapshot||snapshot.version!==input.version||Date.now()-Date.parse(snapshot.checkedAt)>30*60000||!remote||productFingerprint(remote)!==input.fingerprint)throw Error('取得した情報が変わったか、30分経過しました。状態を取得し直してください。');
 if(!remote.imageUrl)throw Error('eコンビニの写真を確認できないため、紐付けできません。');
 if(remote.inventoryMarker&&remote.inventoryMarker!==item.id)throw Error('別の在庫番号が登録されているため、紐付けできません。');
 if(workflows.some(w=>w.save.productId===remote.productId&&w.inventoryId!==item.id)||workflows.some(w=>w.inventoryId===item.id&&w.save.productId&&w.save.productId!==remote.productId))throw Error('別の商品との紐付けがあるため変更できません。');
 const old=data.links.find(l=>l.inventoryId===item.id);
 if(old&&old.productId!==remote.productId)throw Error('先に現在の紐付けを解除してください。');
 if(data.links.some(l=>l.productId===remote.productId&&l.inventoryId!==item.id))throw Error('このeコンビニ商品は別の在庫と紐付いています。');
 const link:ManualLink={inventoryId:item.id,productId:remote.productId,inventoryName:String(item.name),remoteTitle:remote.title,linkedAt:new Date().toISOString(),actor,baseline:remote.channels,revision:(old?.revision??0)+1};
 try{await db.send(new TransactWriteCommand({TransactItems:[
  {ConditionCheck:{TableName:table,Key:cacheKey,ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':snapshot.version}}},
  {ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id:item.id},ConditionExpression:'updatedAt=:v AND (attribute_not_exists(isDeleted) OR isDeleted=:no)',ExpressionAttributeValues:{':v':item.updatedAt,':no':false}}},
  {Put:{TableName:table,Item:{...ownerKey(remote.productId),inventoryId:item.id},ConditionExpression:'attribute_not_exists(inventoryId) OR inventoryId=:id',ExpressionAttributeValues:{':id':item.id}}},
  {Put:{TableName:table,Item:{...linkKey(item.id),...link},ConditionExpression:old?'revision=:revision':'attribute_not_exists(pk) OR disabled=:yes',ExpressionAttributeValues:old?{':revision':old.revision}:{':yes':true}}}
 ]}));}catch{throw Error('紐付けの保存結果を確認できません。一覧を読み直してください。');}
 return readManualSync();
}
export async function unlinkExternalProduct(inventoryId:string,revision:number,actor:string){
 const {links}=await readManualSync(),link=links.find(l=>l.inventoryId===inventoryId);
 if(!link)return readManualSync();
 if(link.revision!==revision)throw Error('紐付けが変わりました。画面を読み直してください。');
 await db.send(new TransactWriteCommand({TransactItems:[
  {Update:{TableName:table,Key:linkKey(inventoryId),UpdateExpression:'SET disabled=:yes, unlinkedAt=:at, unlinkedBy=:actor, revision=:next',ConditionExpression:'revision=:rev',ExpressionAttributeValues:{':yes':true,':at':new Date().toISOString(),':actor':actor,':rev':revision,':next':revision+1}}},
  {Update:{TableName:table,Key:ownerKey(link.productId),UpdateExpression:'REMOVE inventoryId',ConditionExpression:'inventoryId=:id',ExpressionAttributeValues:{':id':inventoryId}}}
 ]}));return readManualSync();
}

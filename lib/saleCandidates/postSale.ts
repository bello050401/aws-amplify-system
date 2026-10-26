import 'server-only';
import {randomUUID} from 'node:crypto';
import {GetCommand,PutCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {candidateStore} from './store';
import {getInventoryRaw} from '@/lib/inventory/categoryPersistence';
import {econveniDatabase as db,ECONVENI_WORKFLOW_TABLE as table} from '@/lib/listing/econveni/runtimeStore';
import {getEcListingCatalogAction} from '@/app/actions/ecListingCatalog';
import {reviewEcListingAction,executeEcListingAction} from '@/app/actions/ecListingOperations';
import {getChannelListing} from '@/lib/listing/service';
import {readBaseItem,claimBaseManual,finishBaseManual} from '@/lib/listing/base/manualLifecycle';
import {setManualBaseStock} from '@/lib/listing/base/adapter';
import type {EcChannel} from '@/lib/listing/ecManagement';
import type {PostSaleRow as Row,PostSalePlan} from './postSaleTypes';
export type {PostSalePlan} from './postSaleTypes';

const channels=['BASE','MERCARI_SHOPS','YAHOO'] as const;
const fromMarket=(market:string):EcChannel|null=>market==='ベイス'?'BASE':market==='メルカリSHOP'?'MERCARI_SHOPS':market==='ヤフオク'?'YAHOO':null;
async function context(candidateId:string){
 const c=await candidateStore().get(candidateId);if(c?.state!=='DONE'||!c.result)throw Error('売却登録を先に完了してください。');
 const [source,sold]=await Promise.all([getInventoryRaw(c.result.sourceId),getInventoryRaw(c.result.soldId)]);
 if(!source||!sold)throw Error('売却した商品の状態を確認できません。');
 const soldChannel:EcChannel|null=c.channel==='MERCARI'?'MERCARI_SHOPS':c.channel==='BASE'?'BASE':c.channel==='YAHOO'?'YAHOO':fromMarket(String(sold.market??''));
 if(c.result.remainingQuantity>0&&source.quantity!==c.result.remainingQuantity||source.updatedAt!==c.result.updatedAt)throw Error('売却後に在庫が変更されています。最新の数量をEC出品画面で確認してください。');
 return {c,source,soldChannel};
}
const key=(id:string)=>({pk:'SALE_EC#'+id});
export async function reviewPostSale(candidateId:string,actor:string,packSizes:Partial<Record<EcChannel,number>>={}):Promise<PostSalePlan>{
 const old=(await db.send(new GetCommand({TableName:table,Key:key(candidateId),ConsistentRead:true}))).Item as (PostSalePlan&{pk:string})|undefined;
 if(old&&old.state!=='REVIEW')return old;
 const {c,source,soldChannel}=await context(candidateId),catalog=await getEcListingCatalogAction();
 if(catalog.errors.length)throw Error('販売先の紐付けを確認できません。再度確認してください。');
 const rows:Row[]=[];
 for(const channel of channels){
  if(channel===soldChannel)continue;
  const linked=catalog.channels[channel]?.[source.id];
  if(!linked?.externalId||linked.state!=='ACTIVE')continue;
  if(c.result!.remainingQuantity===0){
   const review=await reviewEcListingAction(source.id,channel,'STOP');
   rows.push({channel,externalId:linked.externalId,operation:'STOP',state:review.status==='READY'?'READY':review.status==='DONE'?'DONE':'BLOCKED',message:review.message,review});
  }else if(channel==='BASE'){
   const remote=await readBaseItem(linked.externalId);
   const pack=packSizes[channel]??1;
   if(!Number.isSafeInteger(pack)||pack<1||pack>10000)throw Error('販売先の1商品あたりの点数を確認してください。');
   const target=Math.min(remote.quantity,Math.floor(c.result!.remainingQuantity/pack));
   rows.push({channel,externalId:linked.externalId,operation:'STOCK',state:remote.hasVariations?'BLOCKED':remote.quantity===target?'DONE':'READY',message:remote.hasVariations?'バリエーション別の在庫はBASEで確認してください。':remote.quantity===target?'現在の数量が残り在庫以下のため変更しません。':'BASEの在庫数量を変更します。セット出品の場合は1商品あたりの点数を確認してください。',beforeQuantity:remote.quantity,targetQuantity:target,unitsPerListing:pack});
  }else rows.push({channel,externalId:linked.externalId,operation:'STOCK',state:'BLOCKED',targetQuantity:c.result!.remainingQuantity,message:'この販売先の公開済み商品の数量更新は未確認です。販売先で数量を変更してください。出品停止には置き換えません。'});
 }
 const plan:PostSalePlan={id:candidateId,candidateId,sourceId:source.id,sourceVersion:source.updatedAt,soldChannel,remaining:c.result!.remainingQuantity,actor,expiresAt:Date.now()+600000,rows,state:'REVIEW',token:randomUUID(),updatedAt:new Date().toISOString()};
 await db.send(new PutCommand({TableName:table,Item:{pk:key(candidateId).pk,...plan},ConditionExpression:old?'#state=:state AND #token=:token':'attribute_not_exists(pk)',...(old?{ExpressionAttributeNames:{'#state':'state','#token':'token'},ExpressionAttributeValues:{':state':'REVIEW',':token':old.token}}:{})}));return plan;
}
export async function executePostSale(candidateId:string,actor:string,token:string,confirmed:boolean):Promise<PostSalePlan>{
 const p=(await db.send(new GetCommand({TableName:table,Key:key(candidateId),ConsistentRead:true}))).Item as PostSalePlan|undefined;
 if(!confirmed||!p||p.actor!==actor||p.token!==token)throw Error('変更内容を確認してください。');
 if(p.state!=='REVIEW')return p;
 const current=await context(candidateId);
 if(p.expiresAt<Date.now()||p.sourceVersion!==current.source.updatedAt||p.soldChannel!==current.soldChannel||p.rows.some(r=>r.channel===current.soldChannel))throw Error('確認期限または対象の商品が変わりました。');
 await db.send(new UpdateCommand({TableName:table,Key:key(candidateId),UpdateExpression:'SET #s=:busy',ConditionExpression:'#s=:review AND #t=:token',ExpressionAttributeNames:{'#s':'state','#t':'token'},ExpressionAttributeValues:{':busy':'EXECUTING',':review':'REVIEW',':token':token}}));
 p.state='EXECUTING';
 for(const row of p.rows){
  if(row.state!=='READY')continue;
  // Record an uncertain outcome before crossing the external boundary. Repeating the request cannot resend it.
  row.state='VERIFY_REQUIRED';row.message='変更結果を確認中です。';await persist(p);
  try{
   const latest=await context(candidateId);
   if(latest.source.updatedAt!==p.sourceVersion||row.channel===latest.soldChannel)throw Error('在庫の状態が変わりました。');
   if(row.operation==='STOP'&&row.review){
    const result=await executeEcListingAction(row.review,true);
    row.state=result.status==='DONE'?'DONE':'BLOCKED';row.message=result.message;
   }else if(row.channel==='BASE'&&row.targetQuantity!==undefined){
    const linked=await getChannelListing(p.sourceId,'BASE');if(linked?.externalListingId!==row.externalId)throw Error('紐付けが変わりました。');
    const remote=await readBaseItem(row.externalId);if(remote.hasVariations||remote.quantity!==row.beforeQuantity)throw Error('販売先の数量が変わりました。確認してください。');
    const lock=await claimBaseManual(linked);
    try{await setManualBaseStock(row.externalId,row.targetQuantity);const read=await readBaseItem(row.externalId);if(read.quantity!==row.targetQuantity)throw Error('数量更新を確認できません。');await finishBaseManual(linked,lock,{status:read.visible?'ACTIVE':'PAUSED'});row.state='DONE';row.message='在庫数量を確認しました。';}
    catch(e){await finishBaseManual(linked,lock,{status:'ERROR',lastError:'売却後の数量更新を確認してください。'}).catch(()=>{});throw e;}
   }
  }catch{row.message='変更結果を確認できません。重複送信せず販売先で確認してください。';}
  await persist(p);
 }
 p.state=p.rows.every(r=>r.state==='DONE')?'COMPLETE':'ATTENTION';await persist(p);return p;
}
async function persist(p:PostSalePlan){await db.send(new PutCommand({TableName:table,Item:{pk:key(p.id).pk,...p,updatedAt:new Date().toISOString()},ConditionExpression:'#t=:t',ExpressionAttributeNames:{'#t':'token'},ExpressionAttributeValues:{':t':p.token}}));}

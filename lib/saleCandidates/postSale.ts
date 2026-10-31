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
import {reviewSaleBinding,reviewSaleAdjustment,executeSaleAdjustment,saleAdjustmentStarted} from '@/lib/listing/econveni/saleAdjustment';
import {stockCountTitle} from '@/lib/inventory/stockCountTitle';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {listCategories} from '@/lib/inventory/queries';
import type {EcChannel} from '@/lib/listing/ecManagement';
import type {PostSaleRow as Row,PostSalePlan} from './postSaleModel';
export type {PostSalePlan} from './postSaleModel';

export class PostSaleError extends Error { constructor(message:string){super(message);this.name='PostSaleError';} }

const channels=['BASE','MERCARI_SHOPS','YAHOO'] as const;
const fromMarket=(market:string):EcChannel|null=>market==='ベイス'?'BASE':market==='メルカリSHOP'?'MERCARI_SHOPS':market==='ヤフオク'?'YAHOO':null;
async function context(candidateId:string){
 const c=await candidateStore().get(candidateId);if(c?.state!=='DONE'||!c.result)throw new PostSaleError('売却登録を先に完了してください。');
 const sourceRead=getInventoryRaw(c.result.sourceId);
 const [source,sold]=await Promise.all([sourceRead,c.result.sourceId===c.result.soldId?sourceRead:getInventoryRaw(c.result.soldId)]);
 if(!source||!sold||source.isDeleted||source.deletedAt||sold.isDeleted||sold.deletedAt)throw new PostSaleError('売却した商品の状態を確認できません。');
 const soldChannel:EcChannel|null=c.channel==='MERCARI'?'MERCARI_SHOPS':c.channel==='BASE'?'BASE':c.channel==='YAHOO'?'YAHOO':fromMarket(String(sold.market??''));
 let sale:Record<string,unknown>|undefined;
 try{const value=typeof sold.customFields==='string'?JSON.parse(sold.customFields):sold.customFields;sale=value?.__belloSale;}catch{}
 const expectedSource=c.result.sourceId===c.result.soldId?c.result.soldQuantity:c.result.remainingQuantity;
 const changed=source.updatedAt!==c.result.updatedAt||sold.updatedAt!==c.result.updatedAt;
 // A note/price/category edit must not permanently strand a completed sale. Rebuild the review
 // against the latest version, but only while the original sale identity and both quantities agree.
 if(source.quantity!==expectedSource||sold.quantity!==c.result.soldQuantity||changed&&(
   sale?.sourceInventoryId!==c.result.sourceId||sale?.physicalQuantity!==c.result.soldQuantity||
   c.channel!=='DIRECT'&&c.orderId&&sold.externalProductId!==c.orderId
 ))throw new PostSaleError('売却後に数量または注文の対応が変更されています。最新の在庫と注文をEC出品画面で確認してください。');
 if(changed){
  const categoryIds=inventoryCategoryIds(sold),masters=await listCategories();
  if(masters.some(m=>categoryIds.includes(m.id)&&['販売中','出品中'].includes(m.name)))throw new PostSaleError('売却した在庫が販売中に戻っています。売却の取り消しや再販売ではないか確認してください。');
 }
 let soldPack=1;const count=sale?.itemsPerUnit;if(typeof count==='number'&&Number.isSafeInteger(count)&&count>0&&count<=10000)soldPack=count;
 return {c,source,soldChannel,soldPack};
}
const key=(id:string)=>({pk:'SALE_EC#'+id});
export async function reviewPostSale(candidateId:string,actor:string,packSizes:Partial<Record<EcChannel,number>>={}):Promise<PostSalePlan>{
 const old=(await db.send(new GetCommand({TableName:table,Key:key(candidateId),ConsistentRead:true}))).Item as (PostSalePlan&{pk:string})|undefined;
 if(old&&(old.state==='COMPLETE'&&old.rows.length>0||old.state==='EXECUTING'&&old.expiresAt>Date.now()))return old;
 const {c,source,soldChannel,soldPack}=await context(candidateId);
 const started=new Set(await Promise.all((old?.rows??[]).filter(r=>r.adjustment).map(async r=>await saleAdjustmentStarted(r.adjustment!)?r.channel:null)));
 const resuming=old?.rows.some(r=>started.has(r.channel)&&r.state!=='DONE');
 const observed=await (resuming?Promise.resolve<Awaited<ReturnType<typeof reviewSaleBinding>>>({remote:null,reviews:{}}):reviewSaleBinding(source.id,actor,c.result!.remainingQuantity===0?channels.filter(channel=>channel!==soldChannel):[])).catch((e:unknown)=>{
  const code=String((e as {code?:string;name?:string})?.code||(e as Error)?.name||'Unknown');
  console.error('SALE_EC_REVIEW_FAILED',{phase:'binding',code:/^[A-Za-z_]{1,64}$/.test(code)?code:'Unknown'});
  throw new PostSaleError('売却登録と保存済みの紐付けは保持されています。eコンビニの最新状態を取得できませんでした。少し待って「結果を再確認」を押してください。');
 });
 const remote=observed.remote,catalog=await getEcListingCatalogAction(source.id);
 if(catalog.errors.length)throw new PostSaleError('販売先の紐付けを確認できません。再度確認してください。');
 const rows:Row[]=[];
 for(const channel of channels){
  const prior=old?.rows.find(r=>r.channel===channel);
  if(prior?.state==='DONE'){rows.push(prior);continue;}
  if(channel===soldChannel){
   if(channel==='YAHOO'&&c.result!.remainingQuantity>0){
    const soldId=c.externalListingId||(c.identifierType==='AUCTION'?c.orderId:'');
    const current=remote?.channels.YAHOO;
   if(prior?.adjustment&&started.has(channel)){if(packSizes.YAHOO!==undefined&&packSizes.YAHOO!==prior.unitsPerListing)throw new PostSaleError('処理開始後は点数を変更できません。');rows.push({...prior,state:'READY'});continue;}
    if(!soldId||current?.listingId!==soldId){rows.push({channel,externalId:soldId,operation:'RELIST',state:'BLOCKED',message:'売れたオークションIDとeコンビニの紐付けを確認してください。別のページは変更しません。'});continue;}
    const pack=packSizes.YAHOO??prior?.unitsPerListing??soldPack;if(!Number.isSafeInteger(pack)||pack<1||pack>10000)throw new PostSaleError('出品1個あたりの点数を確認してください。');
    if(c.result!.remainingQuantity<pack){rows.push({channel,externalId:soldId,operation:'MANUAL',state:'BLOCKED',message:'残り在庫が1セット分に足りません。セット内容を手動で確認してください。',unitsPerListing:pack});continue;}
    const adjustment=await reviewSaleAdjustment({candidateId,inventoryId:source.id,channel,listingId:soldId,remaining:c.result!.remainingQuantity,pack,inventoryVersion:source.updatedAt});
    rows.push({channel,externalId:soldId,operation:'RELIST',state:adjustment?'READY':'BLOCKED',message:adjustment?'eコンビニの「消」で古いIDを解除し、残り在庫を新しい商品ページとして出品します。売却済みページは残ります。':'先にeコンビニと商品を紐付けてください。',adjustment:adjustment??undefined,requiresTerms:true,targetQuantity:adjustment?.quantity,beforeQuantity:adjustment?.beforeQuantity,unitsPerListing:pack,currentState:'売却済み'});
   }else if(channel==='MERCARI_SHOPS'&&c.result!.remainingQuantity>0)rows.push({channel,externalId:c.externalListingId??'',operation:'MANUAL',state:'BLOCKED',targetQuantity:c.result!.remainingQuantity,message:'売れたページを残し、メルカリShopsで残り数量を手動変更してください。',currentState:'売却先・ページ保持'});
   continue;
  }
  if(prior?.adjustment&&started.has(channel)){if(packSizes[channel]!==undefined&&packSizes[channel]!==prior.unitsPerListing)throw new PostSaleError('処理開始後は点数を変更できません。');rows.push({...prior,state:'READY'});continue;}
  const linked=catalog.channels[channel]?.[source.id];
  if(!linked?.externalId)continue;
  if(prior&&prior.externalId!==linked.externalId){rows.push({...prior,state:'BLOCKED',message:'出品番号が変更されています。EC出品画面で確認してください。'});continue;}
  const fresh=remote?.channels[channel];
  if(fresh?.listingId&&fresh.listingId!==linked.externalId)throw new PostSaleError('最新の出品IDと保存された紐付けが一致しません。');
  const prepared=observed.reviews[channel];
  if(fresh&&!fresh.listingId&&linked.externalId&&channel!=='BASE'&&prepared?.status!=='DONE'){
   rows.push({channel,externalId:linked.externalId,operation:c.result!.remainingQuantity===0?'STOP':'MANUAL',state:'BLOCKED',currentState:'出品番号未確認',message:'eコンビニで出品番号が外れています。出品停止済みとは断定できないため、販売先で確認してください。別の商品への操作は行いません。'});continue;
  }
  if(!prepared&&(fresh?fresh.state!=='ACTIVE':linked.state!=='ACTIVE')&&!prior)continue;
  if(c.result!.remainingQuantity===0){
   const review=prepared??await reviewEcListingAction(source.id,channel,'STOP');
   rows.push({channel,externalId:linked.externalId,operation:'STOP',state:review.status==='READY'?'READY':review.status==='DONE'?'DONE':'BLOCKED',message:review.message,review,currentState:review.status==='DONE'?'停止中':fresh?.state==='ACTIVE'?'出品中':'状態確認'});
  }else if(channel==='BASE'){
   const remote=await readBaseItem(linked.externalId);
   const pack=packSizes[channel]??prior?.unitsPerListing??1;
   if(!Number.isSafeInteger(pack)||pack<1||pack>10000)throw new PostSaleError('販売先の1商品あたりの点数を確認してください。');
   const target=Math.min(remote.quantity,Math.floor(c.result!.remainingQuantity/pack));
   if(prior?.state==='VERIFY_REQUIRED'){
    rows.push({...prior,state:remote.quantity===prior.targetQuantity&&remote.title===(prior.targetTitle??stockCountTitle(remote.title,c.result!.remainingQuantity))?'DONE':'VERIFY_REQUIRED',message:remote.quantity===prior.targetQuantity&&remote.title===(prior.targetTitle??stockCountTitle(remote.title,c.result!.remainingQuantity))?'前回の数量更新を確認しました。':'前回の数量更新は未確認です。再送せずBASEで確認してください。'});continue;
   }
   const adjustment=remote.hasVariations?null:await reviewSaleAdjustment({candidateId,inventoryId:source.id,channel,listingId:linked.externalId,remaining:c.result!.remainingQuantity,pack,inventoryVersion:source.updatedAt});
   rows.push({channel,externalId:linked.externalId,operation:'STOCK',state:remote.hasVariations?'BLOCKED':adjustment?'READY':remote.quantity===target&&stockCountTitle(remote.title,c.result!.remainingQuantity)===remote.title?'DONE':'READY',message:remote.hasVariations?'バリエーション別の在庫はBASEで確認してください。':adjustment?'eコンビニの保存情報を揃えてからBASEの数量を変更します。':'BASEの在庫数量を変更します。',beforeQuantity:remote.quantity,beforeTitle:remote.title,targetTitle:stockCountTitle(remote.title,c.result!.remainingQuantity),targetQuantity:target,unitsPerListing:pack,adjustment:adjustment??undefined,currentState:remote.visible?'出品中':'停止中'});
  }else rows.push({channel,externalId:linked.externalId,operation:'MANUAL',state:'BLOCKED',targetQuantity:c.result!.remainingQuantity,message:channel==='MERCARI_SHOPS'?'メルカリShopsで残り数量を手動変更してください。出品の削除は行いません。':'出品中のヤフオクは、残り在庫に合わせて手動で確認してください。売却済みページの再出品とは別の操作です。',currentState:'出品中'});
 }
 const plan:PostSalePlan={id:candidateId,candidateId,sourceId:source.id,sourceVersion:source.updatedAt,soldChannel,remaining:c.result!.remainingQuantity,actor,expiresAt:Date.now()+600000,rows,state:'REVIEW',token:randomUUID(),updatedAt:new Date().toISOString(),title:String(source.name),productId:remote?.productId??old?.productId,checkedAt:new Date().toISOString()};
 await db.send(new PutCommand({TableName:table,Item:{pk:key(candidateId).pk,...plan},ConditionExpression:old?'#state=:state AND #token=:token':'attribute_not_exists(pk)',...(old?{ExpressionAttributeNames:{'#state':'state','#token':'token'},ExpressionAttributeValues:{':state':old.state,':token':old.token}}:{})}));return plan;
}
export async function executePostSale(candidateId:string,actor:string,token:string,confirmed:boolean,terms=false):Promise<PostSalePlan>{
 const p=(await db.send(new GetCommand({TableName:table,Key:key(candidateId),ConsistentRead:true}))).Item as PostSalePlan|undefined;
 if(!confirmed||!p||p.actor!==actor||p.token!==token)throw new PostSaleError('変更内容を確認してください。');
 if(p.state!=='REVIEW')return p;
 const current=await context(candidateId);
 if(p.expiresAt<Date.now()||p.sourceVersion!==current.source.updatedAt||p.soldChannel!==current.soldChannel||p.rows.some(r=>r.channel===current.soldChannel&&r.operation!=='RELIST'&&r.operation!=='MANUAL'))throw new PostSaleError('確認期限または対象の商品が変わりました。');
 if(p.rows.some(r=>r.state==='READY'&&r.requiresTerms)&&!terms)throw new PostSaleError('Yahoo!オークションのガイドラインを確認してください。');
 if(p.nextAt&&p.nextAt>Date.now())return p;
 await db.send(new UpdateCommand({TableName:table,Key:key(candidateId),UpdateExpression:'SET #s=:busy',ConditionExpression:'#s=:review AND #t=:token',ExpressionAttributeNames:{'#s':'state','#t':'token'},ExpressionAttributeValues:{':busy':'EXECUTING',':review':'REVIEW',':token':token}}));
 p.state='EXECUTING';
 p.nextAt=undefined;
 for(const row of p.rows){
  if(row.state!=='READY')continue;
  // Record an uncertain outcome before crossing the external boundary. Repeating the request cannot resend it.
  row.state='VERIFY_REQUIRED';row.message='変更結果を確認中です。';await persist(p);
  try{
   const latest=await context(candidateId);
   if(latest.source.updatedAt!==p.sourceVersion||row.channel===latest.soldChannel&&row.operation!=='RELIST')throw new PostSaleError('在庫の状態が変わりました。');
   if(row.adjustment){
    const result=await executeSaleAdjustment(row.adjustment);
    row.state=result.status==='DONE'?'DONE':result.status==='WAIT'?'READY':'VERIFY_REQUIRED';row.message=result.message;
    if('newListingId'in result)row.newListingId=result.newListingId;
    if(result.status==='WAIT'){p.nextAt=result.nextAt??Date.now()+30000;p.state='REVIEW';await persist(p);return p;}
   }else if(row.operation==='STOP'&&row.review){
    const result=await executeEcListingAction(row.review,true);
    row.state=result.status==='DONE'?'DONE':result.status==='WAIT'?'READY':'BLOCKED';row.message=result.message;
    if(result.status==='WAIT'){p.nextAt=result.nextAt??Date.now()+30000;p.state='REVIEW';await persist(p);return p;}
   }else if(row.channel==='BASE'&&row.targetQuantity!==undefined){
    const linked=await getChannelListing(p.sourceId,'BASE');if(linked?.externalListingId!==row.externalId)throw new PostSaleError('紐付けが変わりました。');
    const remote=await readBaseItem(row.externalId);if(remote.hasVariations||remote.quantity!==row.beforeQuantity||row.beforeTitle!==undefined&&remote.title!==row.beforeTitle)throw new PostSaleError('販売先の数量が変わりました。確認してください。');
    const lock=await claimBaseManual(linked);
    try{const title=stockCountTitle(remote.title,p.remaining);await setManualBaseStock(row.externalId,row.targetQuantity,title);const read=await readBaseItem(row.externalId);if(read.quantity!==row.targetQuantity||read.title!==title)throw new PostSaleError('数量更新を確認できません。');await finishBaseManual(linked,lock,{status:read.visible?'ACTIVE':'PAUSED'});row.state='DONE';row.message='在庫数量を確認しました。';}
    catch(e){await finishBaseManual(linked,lock,{status:'ERROR',lastError:'売却後の数量更新を確認してください。'}).catch(()=>{});throw e;}
   }
  }catch{row.message='変更結果を確認できません。重複送信せず販売先で確認してください。';}
  await persist(p);
 }
 p.state=p.rows.every(r=>r.state==='DONE')?'COMPLETE':'ATTENTION';await persist(p);return p;
}
async function persist(p:PostSalePlan){await db.send(new PutCommand({TableName:table,Item:{pk:key(p.id).pk,...p,updatedAt:new Date().toISOString()},ConditionExpression:'#t=:t',ExpressionAttributeNames:{'#t':'token'},ExpressionAttributeValues:{':t':p.token}}));}

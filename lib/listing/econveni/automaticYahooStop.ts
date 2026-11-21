import 'server-only';
import {createHash} from 'node:crypto';
import {GetCommand,type TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import {inventoryTable,getInventoryRaw} from '@/lib/inventory/categoryPersistence';
import {candidateStore,candidateConfig} from '@/lib/saleCandidates/store';
import {runAutomaticYahooStop,automaticYahooStopKey,type AutomaticYahooStopRequest,type AutomaticYahooStopReceipt,type AutomaticYahooStopBinding,type AutomaticYahooStopResult} from '@/lib/saleCandidates/automaticYahooStopCore';
import {readYahooRuntimeSession,yahooRuntimeConfig} from '../yahooAuction/webHttpRuntime';
import {econveniDatabase as db,ECONVENI_WORKFLOW_TABLE as table,econveniStore} from './runtimeStore';
import {readManualSync} from './manualSync';
import {selectManualLink,manualLinkKey} from './manualSyncModel';
import {stopReceiptKey} from './manualStopCore';
import {EconveniHttpSession} from './httpSession';
import {withEconveniAccount} from './accountWorkflow';
import {econveniCredentialStore} from './credentials';

type Checks=NonNullable<TransactWriteCommandInput['TransactItems']>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const get=async(TableName:string,Key:Record<string,string>)=>(await db.send(new GetCommand({TableName,Key,ConsistentRead:true}))).Item;
const revisionCheck=(TableName:string,Key:Record<string,string>,value:Record<string,unknown>|undefined):Checks[number]=>({ConditionCheck:{TableName,Key,...(value?{ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':value.revision}}:{ConditionExpression:'attribute_not_exists('+Object.keys(Key)[0]+')'})}});
const held:AutomaticYahooStopResult={status:'REVIEW',message:'ヤフオクの認証・紐付け・前回処理または手数料なし取消を確認できないため、自動停止を保留しています。売却登録は保存済みです。'};

/** Automatic STOP only: no eConveni cancellation, legacy writer enablement or fee acceptance. */
export async function automaticYahooStop(request:AutomaticYahooStopRequest):Promise<AutomaticYahooStopResult>{
 let prior:AutomaticYahooStopReceipt|undefined;
 try{prior=await get(table,{pk:automaticYahooStopKey(request)}) as AutomaticYahooStopReceipt|undefined;}catch{return {status:'VERIFY_REQUIRED',message:'前回の取消受付を確認できません。再送せず確認してください。'};}
 const pending=!!prior&&prior.state!=='DONE'||request.reconcileOnly===true;
 const blocked=()=>pending?{status:'VERIFY_REQUIRED' as const,message:'前回の取消結果を確認できません。再送せず、認証・紐付け・同じ出品の停止結果を確認してください。'}:held;
 const yahoo=await readYahooRuntimeSession();if(!yahoo.ok)return blocked();
 const store=econveniStore(request.inventoryId),session=new EconveniHttpSession();
 try{return await withEconveniAccount(store,session,()=>econveniCredentialStore.credentials(),async()=>{
  let checks:Checks=[];
  const loadBinding=async():Promise<AutomaticYahooStopBinding>=>{
   const [item,candidate,manual,workflow,manualStop,legacy]=await Promise.all([
    getInventoryRaw(request.inventoryId),candidateStore().get(request.candidateId),readManualSync(request.inventoryId),store.read(),
    get(table,{pk:stopReceiptKey(request.inventoryId,'YAHOO')}),get(inventoryTable('YahooAuctionListing'),{inventoryId:request.inventoryId}),
   ]);
   if(!item||item.isDeleted||item.deletedAt||item.updatedAt!==request.inventoryVersion||candidate?.state!=='DONE'||!['BASE','MERCARI'].includes(candidate.channel)||candidate.result?.sourceId!==request.inventoryId||candidate.result.remainingQuantity!==0)throw Error('SALE_BINDING_CHANGED');
   const link=selectManualLink(manual,request.inventoryId,'YAHOO'),productId=link?.productId??workflow?.save.productId;
   if(!productId||link?.baseline.YAHOO.listingId&&link.baseline.YAHOO.listingId!==request.externalId||workflow&&(['PENDING','VERIFY_REQUIRED'].includes(workflow.save.state)||Object.values(workflow.channels).some(c=>['PENDING','VERIFY_REQUIRED'].includes(c.state))))throw Error('SALE_BINDING_UNCONFIRMED');
   if(!link&&(workflow?.save.productId!==productId||workflow.channels.YAHOO.listingId!==request.externalId))throw Error('SALE_BINDING_CHANGED');
   if(manualStop&&(!['READY','DONE'].includes(manualStop.state)||manualStop.listingId!==request.externalId))throw Error('PRIOR_STOP_UNCONFIRMED');
   const owner=link?await get(table,{pk:'ECONVENI#MANUAL_OWNER#'+productId}):undefined;
   if(link&&owner?.inventoryId!==request.inventoryId)throw Error('SALE_BINDING_CHANGED');
   const targetKey={pk:'ECONVENI#NATIVE_TARGET#'+productId+'#YAHOO'},target=await get(table,targetKey);
   if(target?.active===true)throw Error('PRIOR_STOP_UNCONFIRMED');
   let priorNative:Record<string,unknown>|undefined;
   if(target?.jobId){priorNative=await get(candidateConfig().tableName,{id:target.jobId});if(priorNative?.phase!=='COMPLETE')throw Error('PRIOR_STOP_UNCONFIRMED');}
   // The confirmed listing registry distinguishes legacy-bound stock. Never interpret denied reads as absence.
   if(legacy&&legacy.auctionId!==request.externalId)throw Error('LEGACY_LISTING_CHANGED');
   const legacyConfig=yahooRuntimeConfig();if(!legacyConfig?.stateTable)throw Error('LEGACY_STATE_UNAVAILABLE');
   const legacyKey={pk:'INVENTORY#'+request.inventoryId},legacyState=await get(legacyConfig.stateTable,legacyKey);
   // Retired direct writers have a different lease. Their stock stays held; an idle snapshot is no concurrency fence.
   if(legacy||legacyState)throw Error('LEGACY_WRITE_FENCE_REQUIRED');
   const remote=await session.readExternalProduct(productId);
   if(remote.productId!==productId||remote.inventoryMarker&&remote.inventoryMarker!==request.inventoryId||remote.channels.YAHOO.listingId!==request.externalId)throw Error('SALE_BINDING_CHANGED');
   checks=[
    {ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id:request.inventoryId},ConditionExpression:'updatedAt=:v AND (attribute_not_exists(isDeleted) OR isDeleted=:no) AND (attribute_not_exists(deletedAt) OR deletedAt=:empty)',ExpressionAttributeValues:{':v':request.inventoryVersion,':no':false,':empty':null}}},
    {ConditionCheck:{TableName:candidateConfig().tableName,Key:{id:request.candidateId},ConditionExpression:'#s=:done AND updatedAt=:v',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':done':'DONE',':v':candidate.updatedAt}}},
    revisionCheck(table,{pk:stopReceiptKey(request.inventoryId,'YAHOO')},manualStop),
    {ConditionCheck:{TableName:table,Key:targetKey,...(target?{ConditionExpression:'jobId=:j AND active=:no',ExpressionAttributeValues:{':j':target.jobId,':no':false}}:{ConditionExpression:'attribute_not_exists(pk)'})}},
    revisionCheck(legacyConfig.stateTable,legacyKey,legacyState),
    {ConditionCheck:{TableName:inventoryTable('YahooAuctionListing'),Key:{inventoryId:request.inventoryId},ConditionExpression:'attribute_not_exists(inventoryId)'}},
   ];
   if(link)checks.push({ConditionCheck:{TableName:table,Key:{pk:manualLinkKey(link)},ConditionExpression:'revision=:r AND productId=:p AND (attribute_not_exists(disabled) OR disabled=:no)',ExpressionAttributeValues:{':r':link.revision,':p':productId,':no':false}}},{ConditionCheck:{TableName:table,Key:{pk:'ECONVENI#MANUAL_OWNER#'+productId},ConditionExpression:'inventoryId=:id',ExpressionAttributeValues:{':id':request.inventoryId}}});
   if(workflow)checks.push(revisionCheck(table,{pk:workflow.pk},workflow));
   if(priorNative)checks.push({ConditionCheck:{TableName:candidateConfig().tableName,Key:{id:target!.jobId},ConditionExpression:'#p=:complete',ExpressionAttributeNames:{'#p':'phase'},ExpressionAttributeValues:{':complete':'COMPLETE'}}});
   return {...request,productId,bindingKind:'ECONVENI_ONLY',bindingVersion:hash([productId,link?.revision??null,workflow?.revision??null,'ECONVENI_ONLY'])};
  };
  const binding=await loadBinding();
  return runAutomaticYahooStop(binding,{
   read:async()=>await get(table,{pk:automaticYahooStopKey(request)}) as AutomaticYahooStopReceipt??null,
   check:async()=>{if(hash(await loadBinding())!==hash(binding))throw Error('SALE_BINDING_CHANGED');},
   observe:()=>yahoo.session.inspectListing(request.externalId),
   cancel:(expected,beforeSend)=>yahoo.session.cancelListingWithoutFee(request.externalId,expected,beforeSend),
   commit:(old,next,reserve)=>store.commitAutomaticYahooStop(old,next,checks,reserve),
  });
 });}catch(e){
  const failure=e as {code?:string;readyAt?:number};if(failure.code==='WAIT_INTERVAL')return {status:'WAIT',nextAt:failure.readyAt,message:'他のEC操作との間隔を保ってから、手数料なし取消の条件を確認します。'};
  if((e as Error).message==='LEGACY_WRITE_FENCE_REQUIRED'&&!pending)return {status:'REVIEW',message:'旧Yahoo連携の取消履歴・同時操作を安全に確認できないため、自動停止を保留しています。売却登録は保存済みです。'};
  return blocked();
 }
}

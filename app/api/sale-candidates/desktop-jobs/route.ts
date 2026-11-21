import {NextResponse} from 'next/server';
import type {TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {getInventoryRaw,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {econveniStore,ECONVENI_WORKFLOW_TABLE} from '@/lib/listing/econveni/runtimeStore';
import {readManualSync} from '@/lib/listing/econveni/manualSync';
import {selectManualLink,manualLinkKey} from '@/lib/listing/econveni/manualSyncModel';
import {reviewSaleBinding} from '@/lib/listing/econveni/saleAdjustment';
import {signDesktopImage} from '@/lib/saleCandidates/desktopImagePreviews';
import {bridgePostHeaderFailure} from '@/lib/listing/mercariBridge/postGuard';
import {desktopImageKeys,desktopJobs,desktopCompletionWakes,refreshDesktopJobAfterYahooPayment} from '@/lib/saleCandidates/desktopJobs';
import {candidateStore,candidateConfig} from '@/lib/saleCandidates/store';
import {bodyLimited,NO_STORE} from '@/lib/invoicing/gateway';
import {assertDesktopIdentity,assertDesktopLease,comparableDesktopTitle,desktopIssueDiagnostic,expectedDesktopBoundaryError,type DesktopIssueCode,type DesktopJob,type DesktopEvidence} from '@/lib/saleCandidates/desktopJobModel';
import {ensureAutomaticSaleBinding} from '@/lib/saleCandidates/saleBinding';
import {reportSaleAutomationFailure} from '@/lib/saleCandidates/errorReporting';
export const dynamic='force-dynamic';
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:NO_STORE});
async function present(job:DesktopJob,actor:string){
 return {...job,lease:job.actor===actor?job.lease:undefined,images:await Promise.all(job.imageKeys.map(async key=>({key,url:await signDesktopImage(key)}))),recognition:'AUTHENTICATED_DESKTOP_ATTESTATION'};
}
/** The endpoint is a job/receipt boundary only. It never controls a browser or changes EC stock. */
export async function GET(request:Request){
 try{
  const session=await inventoryMutationSession();if(session?.role!=='ADMIN')return reply({error:'管理者のみ利用できます。'},403);
  const u=new URL(request.url),id=u.searchParams.get('id');
  const inventoryId=u.searchParams.get('inventoryId');
  if(inventoryId){
   if(!/^[A-Za-z0-9-]{8,80}$/.test(inventoryId))return reply({error:'在庫ページの番号を確認してください。'},400);
   const item=await getInventoryRaw(inventoryId);if(!item||item.deletedAt||item.isDeleted)return reply({error:'在庫がありません。'},404);
   const {remote}=await reviewSaleBinding(inventoryId,session.owner),keys=await desktopImageKeys(item);
   return reply({inventory:{id:inventoryId,title:String(item.name),version:String(item.updatedAt),externalId:remote?.channels.MERCARI_SHOPS.listingId??null,images:await Promise.all(keys.map(async key=>({key,url:await signDesktopImage(key)})))}});
  }
  if(id){const job=await desktopJobs.get(id);return job?reply({job:await present(job,session.owner)}):reply({error:'受付がありません。'},404);}
  const page=await desktopJobs.list(u.searchParams.get('cursor')??undefined);
  return reply({jobs:await Promise.all(page.jobs.map(j=>present(j,session.owner))),cursor:page.cursor});
 }catch{return reply({error:'PC照合の受付を取得できませんでした。'},503);}
}
async function bindingChecks(inventoryId:string,externalId:string,actor:string){
 const [manual,workflow]=await Promise.all([readManualSync(inventoryId),econveniStore(inventoryId).read()]);
 const link=selectManualLink(manual,inventoryId,'MERCARI_SHOPS'),table=ECONVENI_WORKFLOW_TABLE;
 // Guard precisely the binding captured before the live read, including relink races.
 const observed=await reviewSaleBinding(inventoryId,actor);
 if(!observed.remote||observed.remote.channels.MERCARI_SHOPS.listingId!==externalId)throw Error('DESKTOP_BINDING_CHANGED');
 const checks:NonNullable<TransactWriteCommandInput['TransactItems']>=[];
 if(link){checks.push({ConditionCheck:{TableName:table,Key:{pk:manualLinkKey(link)},ConditionExpression:'revision=:r AND productId=:p AND (attribute_not_exists(disabled) OR disabled=:no)',ExpressionAttributeValues:{':r':link.revision,':p':link.productId,':no':false}}},{ConditionCheck:{TableName:table,Key:{pk:'ECONVENI#MANUAL_OWNER#'+link.productId},ConditionExpression:'inventoryId=:i',ExpressionAttributeValues:{':i':inventoryId}}});}
 else if(workflow?.save.productId===observed.remote.productId)checks.push({ConditionCheck:{TableName:table,Key:{pk:workflow.pk},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':workflow.revision}}});
 else throw Error('DESKTOP_BINDING_CHANGED');
 return checks;
}
const inventoryCheck=(id:string,version:string)=>({ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id},ConditionExpression:'updatedAt=:v',ExpressionAttributeValues:{':v':version}}});
function boundedEvidence(raw:unknown):DesktopEvidence{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('DESKTOP_EVIDENCE_MISMATCH');
 const v=raw as Record<string,unknown>;
 return Object.fromEntries(['snapshot','externalId','inventoryId','inventoryVersion','orderId','orderLineId','observedTitle','expectedImageKey','titleMatched','imageMatched','observedEvidenceRef','observedAt','observedQuantity','observedState'].filter(k=>v[k]!==undefined).map(k=>[k,v[k]])) as DesktopEvidence;
}
async function currentIdentity(job:DesktopJob,allowOldReadback:boolean,actor:string){
 const [candidate,item]=await Promise.all([candidateStore().get(job.candidateId),getInventoryRaw(job.inventoryId)]);
 if(!candidate||candidate.orderId!==job.orderId||(candidate.orderLineId??'')!==job.orderLineId||!item||item.deletedAt||item.isDeleted)throw Error('DESKTOP_IDENTITY_CHANGED');
 if(job.purpose==='VERIFY_SALE'){
  if(candidate.channel!=='MERCARI'||candidate.state!=='PENDING'||candidate.externalListingId!==job.externalId)throw Error('DESKTOP_ORDER_CHANGED');
 }else if(candidate.state!=='DONE'||candidate.result?.sourceId!==job.inventoryId||candidate.result.remainingQuantity!==job.targetQuantity)throw Error('DESKTOP_ORDER_CHANGED');
 if(!allowOldReadback&&(item.updatedAt!==job.inventoryVersion||JSON.stringify(await desktopImageKeys(item))!==JSON.stringify(job.imageKeys)))throw Error('DESKTOP_STALE_INVENTORY');
 const checks=allowOldReadback?[]:await bindingChecks(job.inventoryId,job.externalId,actor);
 return {item,candidate,checks};
}
export async function POST(request:Request){
 let trustedJob:DesktopJob|undefined;
 try{
  const session=await inventoryMutationSession();if(session?.role!=='ADMIN')return reply({error:'管理者のみ利用できます。'},403);
  const failure=bridgePostHeaderFailure({origin:request.headers.get('origin'),requestOrigin:new URL(request.url).origin,configuredPublicOrigin:process.env.BELLO_MOBILE_PUBLIC_ORIGIN,contentType:request.headers.get('content-type'),hasNextAction:request.headers.has('next-action')});
  if(failure||request.headers.get('x-bello-sale-desktop')!=='1')return reply({error:'同じBELLO画面から操作してください。'},403);
  const b=await bodyLimited(request);
  if(typeof b.id!=='string'||!/^([a-f0-9]{64})$/.test(b.id))return reply({error:'受付番号を確認してください。'},400);
  let job=await desktopJobs.get(b.id);if(!job)return reply({error:'受付がありません。'},404);
  trustedJob=job;
  if(b.action==='claim'){
   job=await refreshDesktopJobAfterYahooPayment(job);
   if(job.purpose==='IDENTIFY_SALE'){
    const c=await candidateStore().get(job.candidateId);
    if(c?.state!=='PENDING'||c.channel!=='MERCARI'||!c.senderAuthenticated||c.orderId!==job.orderId||c.mercariOrderUrl!==job.orderUrl||c.mercariShopId!==job.shopId||c.name!==job.title||c.quantity!==job.soldQuantity||c.unitPrice!==job.unitPrice)throw Error('DESKTOP_ORDER_CHANGED');
   }else await currentIdentity(job,!!job.writeStartedAt,session.owner);
   return reply({job:await present(await desktopJobs.claim(job.id,session.owner),session.owner)});
  }
  if(typeof b.lease!=='string')return reply({error:'受付を取得し直してください。'},400);
  if(b.action==='report-error'){
   const saved=await desktopJobs.recordIssue(job.id,session.owner,b.lease,b.code);
   const diagnostic=desktopIssueDiagnostic(b.code as DesktopIssueCode);
   const reported=await reportSaleAutomationFailure(job.candidateId,job.purpose==='STOCK'?'EC':'IDENTIFY',diagnostic,candidateConfig().tableName);
   return reply({job:await present(saved,session.owner),reported,operational:b.code==='AUTH_REQUIRED'||b.code==='RATE_LIMITED'});
  }
  if(b.action==='start-write'){
   const {item,checks}=await currentIdentity(job,false,session.owner);
   const saved=await desktopJobs.startWrite(job.id,session.owner,b.lease,boundedEvidence(b.evidence),{table:inventoryTable('Inventory'),id:job.inventoryId,version:String(item.updatedAt)},checks);
   return reply({job:await present(saved,session.owner),permission:'ONE_WRITE_THEN_READBACK'});
  }
  if(b.action==='finish'){
   const e=boundedEvidence(b.evidence);let checks:NonNullable<TransactWriteCommandInput['TransactItems']>=[];
   if(job.state!=='COMPLETE'&&job.purpose==='IDENTIFY_SALE'){
    assertDesktopLease(job,session.owner,b.lease,Date.now());assertDesktopIdentity(job,e,Date.now());
    const [c,item]=await Promise.all([candidateStore().get(job.candidateId),getInventoryRaw(e.inventoryId)]);
    if(c?.state!=='PENDING'||c.channel!=='MERCARI'||!c.senderAuthenticated||c.orderId!==job.orderId||c.mercariOrderUrl!==job.orderUrl||c.mercariShopId!==job.shopId||c.name!==job.title||c.quantity!==job.soldQuantity||c.unitPrice!==job.unitPrice||c.externalListingId&&c.externalListingId!==e.externalId||!item||item.isDeleted||item.deletedAt||item.updatedAt!==e.inventoryVersion||!((await desktopImageKeys(item)).includes(e.expectedImageKey))||comparableDesktopTitle(String(item.name))!==comparableDesktopTitle(e.observedTitle))throw Error('DESKTOP_IDENTIFICATION_CHANGED');
    if(!await ensureAutomaticSaleBinding(e.inventoryId,'MERCARI_SHOPS',e.externalId,session.owner))throw Error('DESKTOP_BINDING_REQUIRED');
    checks=await bindingChecks(e.inventoryId,e.externalId,session.owner);
    checks.push(inventoryCheck(e.inventoryId,e.inventoryVersion!));
    const at=new Date(Math.max(Date.now(),Date.parse(c.updatedAt)+1)).toISOString();
    checks.push({Put:{TableName:candidateConfig().tableName,Item:{...c,externalListingId:e.externalId,suggestedInventoryId:e.inventoryId,mercariDesktopIdentity:{jobId:job.id,snapshot:job.snapshot,inventoryVersion:e.inventoryVersion,evidenceRef:e.observedEvidenceRef,actor:session.owner,verifiedAt:at},updatedAt:at},ConditionExpression:'#s=:p AND updatedAt=:v',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':p':'PENDING',':v':c.updatedAt}}});
   }else if(job.state!=='COMPLETE'){
    const result=await currentIdentity(job,!!job.writeStartedAt,session.owner);checks=result.checks;
    if(!job.writeStartedAt)checks.push(inventoryCheck(job.inventoryId,job.inventoryVersion));
   }
   // A durable completed replay returns before touching any successor, even after a lost ACK.
   if(job.state!=='COMPLETE')checks.push(...await desktopCompletionWakes(job.candidateId));
   return reply({job:await present(await desktopJobs.finish(job.id,session.owner,b.lease,e,checks),session.owner)});
  }
  return reply({error:'操作を確認してください。'},400);
 }catch(error){
  const code=(error as Error).message;
  const expected=expectedDesktopBoundaryError(error);
  const reported=trustedJob&&!expected?await reportSaleAutomationFailure(trustedJob.candidateId,trustedJob.purpose==='STOCK'?'EC':'IDENTIFY','DESKTOP_RUNTIME_FAILED',candidateConfig().tableName):false;
  return reply({error:'状態または照合結果が一致しません。変更を繰り返さず、最新の在庫・注文・PC画面を確認してください。',code:expected&&/^DESKTOP_[A-Z_]+$/.test(code)?code:'DESKTOP_STORAGE_OR_CONFLICT',reported},expected?409:503);
 }
}

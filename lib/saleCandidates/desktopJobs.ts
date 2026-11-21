import 'server-only';
import {GetCommand} from '@aws-sdk/lib-dynamodb';
import {getInventoryRaw} from '../inventory/categoryPersistence';
import {econveniDatabase,ECONVENI_WORKFLOW_TABLE} from '../listing/econveni/runtimeStore';
import {createDesktopJobStore} from './desktopJobStore';
import type {SaleCandidate} from './model';
import type {DesktopRequest} from './desktopJobModel';
import {candidateStore,candidateConfig} from '@/lib/saleCandidates/store';
import {desktopImageKeys} from './desktopImages';
import {settledYahooContinuation} from './yahooSettlementContinuationServer';
import {desktopCausalSnapshotMatches,type DesktopJob} from './desktopJobModel';
import {canReuseMercariIdentification,completedDesktopStockReceipt,desktopSuccessorWakeWrites,type DesktopSuccessor} from './desktopCompletion';
import {postSaleJobId} from './postSaleQueueCore';
export {desktopImageKeys} from './desktopImages';

export const desktopJobs=createDesktopJobStore(econveniDatabase,ECONVENI_WORKFLOW_TABLE);
export async function resolveMercariSale(c:SaleCandidate):Promise<{status:'DONE'|'WAIT'|'REVIEW';nextAt?:number;reason?:string}> {
 if(c.externalListingId)return {status:'DONE'};
 const data=c as SaleCandidate&{mercariOrderUrl?:string;mercariShopId?:string};
 if(c.channel!=='MERCARI'||c.source!=='GMAIL'||!c.senderAuthenticated||!data.mercariOrderUrl||!data.mercariShopId||!c.orderId||c.quantity===null||c.unitPrice===null)return {status:'REVIEW',reason:'MERCARI_ORDER_CONTEXT_REQUIRED'};
 let url:URL;try{url=new URL(data.mercariOrderUrl);}catch{return {status:'REVIEW'};}
 if(url.origin!=='https://mercari-shops.com'||url.pathname!==`/seller/shops/${data.mercariShopId}/orders/${c.orderId.replace(/^order_/,'')}`||url.search||url.hash)return {status:'REVIEW',reason:'MERCARI_ORDER_URL_INVALID'};
 const {job,matches}=await desktopJobs.ensure({purpose:'IDENTIFY_SALE',candidateId:c.id,inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',externalId:'ORDER:'+c.orderId,title:c.name,imageKeys:[],orderId:c.orderId,orderLineId:c.orderLineId??'',orderUrl:data.mercariOrderUrl,shopId:data.mercariShopId,soldQuantity:c.quantity,unitPrice:c.unitPrice});
 return !matches||job.state==='ATTENTION'?{status:'REVIEW',reason:'MERCARI_IDENTIFICATION_REVIEW'}:job.state==='COMPLETE'?{status:'DONE'}:{status:'WAIT',nextAt:job.state==='WAITING'?job.nextAt:Date.now()+60000};
}
export async function verifyMercariSale(c:SaleCandidate,inventory:Record<string,unknown>):Promise<{status:'DONE'|'WAIT'|'REVIEW';nextAt?:number}> {
 if(c.channel!=='MERCARI'||!c.externalListingId||!c.orderId||!inventory.updatedAt)return {status:'REVIEW'};
 const request:DesktopRequest={purpose:'VERIFY_SALE',candidateId:c.id,inventoryId:String(inventory.id??''),inventoryVersion:String(inventory.updatedAt),externalId:c.externalListingId,title:String(inventory.name??''),imageKeys:await desktopImageKeys(inventory),orderId:c.orderId,orderLineId:c.orderLineId??''};
 if(!request.imageKeys.length)return {status:'REVIEW'};
 if(c.mercariDesktopIdentity){
  const identified=await desktopJobs.get(c.mercariDesktopIdentity.jobId);
  if(canReuseMercariIdentification(c,inventory,request.imageKeys,identified,Date.now()))return {status:'DONE'};
 }
 const {job,matches}=await desktopJobs.ensure(request);
 return !matches||job.state==='ATTENTION'?{status:'REVIEW'}:job.state==='COMPLETE'?{status:'DONE'}:{status:'WAIT',nextAt:job.state==='WAITING'?job.nextAt:Date.now()+60000};
}
export async function desktopCompletionWakes(candidateId:string){
 const table=candidateConfig().tableName;
 const rows=await Promise.all(['AUTO:'+candidateId,postSaleJobId(candidateId)].map(async id=>(await econveniDatabase.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item as DesktopSuccessor|undefined));
 return desktopSuccessorWakeWrites(candidateId,rows,table,Date.now());
}
/** Read-only timer preflight. It cannot create, claim, rebase, or execute a desktop job. */
export async function postSaleMercariComplete(input:{candidateId:string;inventoryId:string;inventoryVersion:string;externalId:string;title:string;targetQuantity:number}):Promise<boolean>{
 const [item,c]=await Promise.all([getInventoryRaw(input.inventoryId),candidateStore().get(input.candidateId)]);
 if(!item||item.updatedAt!==input.inventoryVersion||c?.state!=='DONE'||c.result?.sourceId!==input.inventoryId||c.result.remainingQuantity!==input.targetQuantity||!c.orderId)return false;
 const request:DesktopRequest={purpose:'STOCK',...input,imageKeys:await desktopImageKeys(item),orderId:c.orderId,orderLineId:c.orderLineId??''};
 const job=await desktopJobs.get(desktopJobs.id(request));
 if(completedDesktopStockReceipt(request,job))return true;
 return !!job&&await canRebaseDesktopAfterYahooPayment(job,request)&&completedDesktopStockReceipt(request,job,true);
}
export async function postSaleMercari(input:{candidateId:string;inventoryId:string;inventoryVersion:string;externalId:string;title:string;targetQuantity:number}):Promise<{status:'DONE'|'WAIT'|'REVIEW'|'VERIFY_REQUIRED';nextAt?:number;message:string}> {
 const [item,candidate]=await Promise.all([getInventoryRaw(input.inventoryId),candidateStore().get(input.candidateId)]);
 if(!item||item.updatedAt!==input.inventoryVersion||candidate?.state!=='DONE'||candidate.result?.sourceId!==input.inventoryId||!candidate.orderId)return {status:'REVIEW',message:'在庫と注文の対応を確認してください。'};
 const images=await desktopImageKeys(item);
 if(!images.length)return {status:'REVIEW',message:'照合に使う在庫画像がありません。'};
 const request:DesktopRequest={purpose:'STOCK',...input,imageKeys:images,orderId:candidate.orderId,orderLineId:candidate.orderLineId??''};
 let {job,matches}=await desktopJobs.ensure(request);
 if(!matches&&job.state!=='ATTENTION'&&await canRebaseDesktopAfterYahooPayment(job,request)){
  if(job.state==='COMPLETE')return {status:'DONE',message:'入金後も同じ注文のPC数量確認記録を保持しています。'};
  if(!job.writeStartedAt){job=await desktopJobs.rebase(job,request);matches=true;}
  else return {status:'WAIT',nextAt:Date.now()+60000,message:'入金前に開始したPC変更を再送せず、実際の数量を読み直します。'};
 }
 if(!matches||job.state==='ATTENTION')return {status:'REVIEW',message:'PC照合の対象または受付状態を確認してください。'};
 if(job.state==='COMPLETE')return {status:'DONE',message:'PC画面で商品名・画像と変更後の数量を確認しました。'};
 return {status:'WAIT',nextAt:job.state==='WAITING'?job.nextAt:Date.now()+60000,message:job.writeStartedAt?'前回の変更結果をPC画面で再確認します。変更操作は繰り返しません。':'同じ受付番号でPCの商品名・画像照合と数量変更を待っています。'};
}
export async function canRebaseDesktopAfterYahooPayment(job:DesktopJob,request:DesktopRequest):Promise<boolean>{
 return job.purpose==='STOCK'&&desktopCausalSnapshotMatches(job,request)&&await settledYahooContinuation(job.candidateId,job.inventoryId,job.inventoryVersion,job.targetQuantity!);
}
export async function refreshDesktopJobAfterYahooPayment(job:DesktopJob):Promise<DesktopJob>{
 if(job.purpose!=='STOCK'||job.writeStartedAt||job.state==='COMPLETE'||job.state==='ATTENTION')return job;
 const item=await getInventoryRaw(job.inventoryId);if(!item||item.updatedAt===job.inventoryVersion)return job;
 const request:DesktopRequest={...job,title:String(item.name),inventoryVersion:String(item.updatedAt),imageKeys:await desktopImageKeys(item)};
 return await canRebaseDesktopAfterYahooPayment(job,request)?desktopJobs.rebase(job,request):job;
}

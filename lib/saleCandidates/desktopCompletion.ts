import {randomUUID} from 'node:crypto';
import type {TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import type {SaleCandidate} from './model';
import {assertDesktopIdentity,comparableDesktopTitle,desktopCausalSnapshotMatches,desktopJobId,desktopSnapshot,type DesktopJob,type DesktopRequest} from './desktopJobModel';
import {postSaleJobId} from './postSaleQueueCore';

export type DesktopSuccessor={id:string;candidateId:string;state:string;version?:string;token?:string;updatedAt?:string};
/** Existing active successors only. Completion and waking commit in one transaction. */
export function desktopSuccessorWakeWrites(candidateId:string,rows:readonly (DesktopSuccessor|undefined)[],table:string,now:number):NonNullable<TransactWriteCommandInput['TransactItems']>{
 return rows.flatMap(row=>{
  if(!row||row.candidateId!==candidateId)return [];
  const automatic=row.id==='AUTO:'+candidateId&&row.state==='SALE_AUTO_ACTIVE';
  const manual=row.id===postSaleJobId(candidateId)&&row.state==='SALE_EC_ACTIVE'&&!!row.token;
  if(!automatic&&!manual||automatic&&!row.version)return [];
  const at=new Date(Math.max(now,Number.isFinite(Date.parse(row.updatedAt??''))?Date.parse(row.updatedAt!)+1:now)).toISOString();
  return [{Update:{TableName:table,Key:{id:row.id},UpdateExpression:'SET nextAt=:zero,#v=:next,updatedAt=:at',ConditionExpression:'attribute_exists(id) AND candidateId=:candidate AND #s=:active AND '+(row.version?'#v=:previous':'attribute_not_exists(#v)')+(manual?' AND #t=:token':''),ExpressionAttributeNames:{'#v':'version','#s':'state',...(manual?{'#t':'token'}:{})},ExpressionAttributeValues:{':candidate':candidateId,':active':row.state,':zero':0,':next':randomUUID(),':at':at,...(row.version?{':previous':row.version}:{}),...(manual?{':token':row.token}:{})}}}];
 });
}

/** Reuses the real order-screen comparison; never substitutes a name-only match. */
export function canReuseMercariIdentification(c:SaleCandidate,inventory:Record<string,unknown>,imageKeys:readonly string[],job:DesktopJob|undefined,now:number):boolean {
 const m=c.mercariDesktopIdentity,e=job?.evidence;
 if(!m||!job||!e||c.state!=='PENDING'||c.channel!=='MERCARI'||c.source!=='GMAIL'||c.senderAuthenticated!==true||job.purpose!=='IDENTIFY_SALE'||job.state!=='COMPLETE'||job.id!==m.jobId||job.id!==desktopJobId(job)||job.snapshot!==m.snapshot||job.snapshot!==desktopSnapshot(job)||job.candidateId!==c.id||job.orderId!==c.orderId||job.orderLineId!==(c.orderLineId??'')||job.orderUrl!==c.mercariOrderUrl||job.shopId!==c.mercariShopId||job.title!==c.name||job.soldQuantity!==c.quantity||job.unitPrice!==c.unitPrice)return false;
 if(c.externalListingId!==e.externalId||c.suggestedInventoryId!==inventory.id||e.inventoryId!==inventory.id||e.inventoryVersion!==inventory.updatedAt||m.inventoryVersion!==inventory.updatedAt||m.actor!==job.actor||m.evidenceRef!==e.observedEvidenceRef||!imageKeys.includes(e.expectedImageKey)||comparableDesktopTitle(String(inventory.name))!==comparableDesktopTitle(e.observedTitle))return false;
 const observed=Date.parse(e.observedAt),completed=Date.parse(job.completedAt??''),verified=Date.parse(m.verifiedAt);
 if(!Number.isFinite(observed)||observed>now||now-observed>30*60000||!Number.isFinite(completed)||completed<observed||completed>now||!Number.isFinite(verified)||verified<observed||verified>now)return false;
 try{assertDesktopIdentity(job,e,now);return true;}catch{return false;}
}
export function completedDesktopStockReceipt(request:DesktopRequest,job:DesktopJob|undefined,causalPaymentContinuation=false):boolean {
 const e=job?.evidence;
 if(!job||!e||job.purpose!=='STOCK'||job.state!=='COMPLETE'||job.id!==desktopJobId(request)||job.snapshot!==desktopSnapshot(job)||job.snapshot!==desktopSnapshot(request)&&!(causalPaymentContinuation&&desktopCausalSnapshotMatches(job,request))||e.snapshot!==job.snapshot||e.externalId!==request.externalId||e.inventoryId!==request.inventoryId||e.orderId!==request.orderId||e.orderLineId!==request.orderLineId||!request.imageKeys.includes(e.expectedImageKey)||e.observedQuantity!==request.targetQuantity||request.targetQuantity===0&&e.observedState!=='STOPPED'||comparableDesktopTitle(e.observedTitle)!==comparableDesktopTitle(request.title))return false;
 const observed=Date.parse(e.observedAt);if(!Number.isFinite(observed))return false;
 try{assertDesktopIdentity(job,e,observed);return true;}catch{return false;}
}

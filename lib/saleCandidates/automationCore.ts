import type {SaleCandidate} from './model';
import type {SoldOutRequest,SoldOutResult} from '../inventory/soldOutInput';
import type {AutomaticDecision} from './automationPolicy';
import type {PostSalePlan} from './postSaleModel';
export type AutomationJob={id:string;candidateId:string;inventoryId?:string;state:'SALE_AUTO_ACTIVE'|'SALE_AUTO_ATTENTION'|'SALE_AUTO_COMPLETE';phase:'IDENTIFY'|'WAITING'|'REVIEW'|'SALE'|'EC'|'COMPLETE';reason?:string;createdAt:string;updatedAt:string;receivedAt:string;nextAt?:number;saleAt?:string;completedAt?:string;attempts:number;elapsedMs?:number;version:string};
export type AutomationPorts={
 now:()=>number;
 candidate:()=>Promise<SaleCandidate|undefined>;
 decide:(c:SaleCandidate)=>Promise<AutomaticDecision>;
 identify?:(c:SaleCandidate)=>Promise<{status:'DONE'|'WAIT'|'REVIEW';reason?:string;nextAt?:number}>;
 /** Required immediately before committing inventory: verified eConveni binding and desktop evidence. */
 prepare:(c:SaleCandidate,request:SoldOutRequest)=>Promise<{status:'DONE'|'WAIT'|'REVIEW';reason?:string;nextAt?:number}>;
 save:(job:AutomationJob)=>Promise<void>;
 sell:(c:SaleCandidate,request:SoldOutRequest)=>Promise<SoldOutResult>;
 review:(id:string)=>Promise<PostSalePlan>;
 execute:(p:PostSalePlan)=>Promise<PostSalePlan>;
};
/** Durable stages + stock transaction + EC receipts make retries read/verify, not blindly replay writes. */
export async function runAutomaticSale(job:AutomationJob,p:AutomationPorts):Promise<AutomationJob>{
 const save=async()=>{job.updatedAt=new Date(p.now()).toISOString();await p.save(job);};
 const attention=async(reason:string)=>{job.state='SALE_AUTO_ATTENTION';job.phase='REVIEW';job.reason=reason;await save();return job;};
 if(job.state==='SALE_AUTO_COMPLETE'||(job.nextAt??0)>p.now())return job;
 let c=await p.candidate();if(!c)return attention('CANDIDATE_REMOVED');
 if(c.state!=='DONE'){
  let d=await p.decide(c);
  if(d.kind==='REVIEW'&&d.reason==='NO_ITEM_ID'&&c.channel==='MERCARI'&&p.identify){
   const identified=await p.identify(c);
   if(identified.status==='REVIEW')return attention(identified.reason??'MERCARI_IDENTIFICATION_REQUIRED');
   if(identified.status==='WAIT'){job.phase='WAITING';job.reason='MERCARI_DESKTOP_IDENTIFICATION';job.nextAt=identified.nextAt??p.now()+6*3600000;await save();return job;}
   const refreshed=await p.candidate();if(!refreshed||refreshed.state!=='PENDING')return attention('STOCK_CHANGED');
   c=refreshed;d=await p.decide(c);
  }
  if(d.kind==='REVIEW')return attention(d.reason);
  if(d.kind==='WAIT'){job.phase='WAITING';job.reason=d.reason;job.nextAt=p.now()+300000;await save();return job;}
  // A read-only corroboration adapter may CAS-enrich facts while deciding.
  const current=await p.candidate();
  if(!current||current.state!=='PENDING')return attention('STOCK_CHANGED');
  if(current.updatedAt!==c.updatedAt){c=current;d=await p.decide(c);if(d.kind==='REVIEW')return attention(d.reason);if(d.kind==='WAIT'){job.phase='WAITING';job.reason=d.reason;job.nextAt=p.now()+300000;await save();return job;}}
  const prepared=await p.prepare(c,d.request);
  if(prepared.status==='REVIEW')return attention(prepared.reason??'PRE_SALE_REVIEW_REQUIRED');
  if(prepared.status==='WAIT'){job.phase='WAITING';job.reason=prepared.reason??'PRE_SALE_WAITING';job.nextAt=prepared.nextAt??p.now()+300000;await save();return job;}
  job.phase='SALE';delete job.reason;await save();
  await p.sell(c,d.request);
  c=await p.candidate();if(c?.state!=='DONE'||!c.result)throw Error('SALE_RESULT_UNCONFIRMED');
 }
 if(!c.result)return attention('SALE_RESULT_UNCONFIRMED');
 const saleResult=c.result;
 job.saleAt??=c.completedAt??new Date(p.now()).toISOString();job.phase='EC';job.state='SALE_AUTO_ACTIVE';delete job.reason;await save();
 let plan=await p.review(c.id);
 if(plan.state==='EXECUTING'){job.nextAt=plan.executionLeaseUntil??plan.expiresAt;await save();return job;}
 if(plan.rows.some(r=>r.channel===plan.soldChannel&&!(plan.remaining>0&&(r.channel==='YAHOO'&&r.operation==='RELIST'||r.channel==='MERCARI_SHOPS'&&r.operation==='STOCK'))&&!(saleResult.quantityDeferred&&r.operation==='MANUAL')))return attention('SOLD_CHANNEL_PROTECTED');
 if(plan.state==='REVIEW'&&(plan.rows.every(r=>r.state==='DONE')||plan.rows.some(r=>r.state==='READY')))plan=await p.execute(plan);
 if(c.result.quantityDeferred){job.phase='WAITING';job.reason='WAITING_PAYMENT';job.nextAt=p.now()+300000;await save();return job;}
 if(plan.state==='COMPLETE'){
  job.phase='COMPLETE';job.state='SALE_AUTO_COMPLETE';job.completedAt=new Date(p.now()).toISOString();job.elapsedMs=Math.max(0,p.now()-Date.parse(job.receivedAt));delete job.nextAt;
 }else if(plan.rows.some(r=>r.state==='READY')&&plan.nextAt){job.nextAt=plan.nextAt;}
 else return attention(plan.rows.some(r=>r.state==='VERIFY_REQUIRED')?'EC_RESULT_UNCONFIRMED':'EC_REVIEW_REQUIRED');
 await save();return job;
}

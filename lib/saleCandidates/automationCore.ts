import type {SaleCandidate} from './model';
import type {SoldOutRequest,SoldOutResult} from '../inventory/soldOutInput';
import type {AutomaticDecision} from './automationPolicy';
import type {PostSalePlan} from './postSaleModel';
export type AutomationJob={id:string;candidateId:string;state:'SALE_AUTO_ACTIVE'|'SALE_AUTO_ATTENTION'|'SALE_AUTO_COMPLETE';phase:'IDENTIFY'|'WAITING'|'REVIEW'|'SALE'|'EC'|'COMPLETE';reason?:string;createdAt:string;updatedAt:string;receivedAt:string;nextAt?:number;saleAt?:string;completedAt?:string;attempts:number;elapsedMs?:number;version:string};
export type AutomationPorts={
 now:()=>number;
 candidate:()=>Promise<SaleCandidate|undefined>;
 decide:(c:SaleCandidate)=>Promise<AutomaticDecision>;
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
  const d=await p.decide(c);
  if(d.kind==='REVIEW')return attention(d.reason);
  if(d.kind==='WAIT'){job.phase='WAITING';job.reason=d.reason;job.nextAt=p.now()+300000;await save();return job;}
  job.phase='SALE';delete job.reason;await save();
  await p.sell(c,d.request);
  c=await p.candidate();if(c?.state!=='DONE'||!c.result)throw Error('SALE_RESULT_UNCONFIRMED');
 }
 if(!c.result)return attention('SALE_RESULT_UNCONFIRMED');
 job.saleAt??=c.completedAt??new Date(p.now()).toISOString();job.phase='EC';job.state='SALE_AUTO_ACTIVE';delete job.reason;await save();
 let plan=await p.review(c.id);
 if(plan.rows.some(r=>r.operation==='RELIST'||r.channel===plan.soldChannel))return attention('SOLD_CHANNEL_PROTECTED');
 if(plan.state==='REVIEW'&&(plan.rows.every(r=>r.state==='DONE')||plan.rows.some(r=>r.state==='READY')))plan=await p.execute(plan);
 if(plan.state==='COMPLETE'){
  job.phase='COMPLETE';job.state='SALE_AUTO_COMPLETE';job.completedAt=new Date(p.now()).toISOString();job.elapsedMs=Math.max(0,p.now()-Date.parse(job.receivedAt));delete job.nextAt;
 }else if(plan.rows.some(r=>r.state==='READY')&&plan.nextAt){job.nextAt=plan.nextAt;}
 else return attention(plan.rows.some(r=>r.state==='VERIFY_REQUIRED')?'EC_RESULT_UNCONFIRMED':'EC_REVIEW_REQUIRED');
 await save();return job;
}

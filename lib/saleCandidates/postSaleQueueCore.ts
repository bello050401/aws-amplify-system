import type {PostSalePlan} from './postSaleModel';

export type PostSaleJob={id:string;candidateId:string;token:string;actor:string;terms:boolean;state:'SALE_EC_ACTIVE'|'SALE_EC_COMPLETE'|'SALE_EC_ATTENTION';createdAt:string;updatedAt:string;nextAt:number;attempts:number;reason?:string;ttl:number};
export const postSaleJobId=(id:string)=>'EC_JOB:'+id;
export function approvedPostSaleJob(plan:PostSalePlan|undefined,actor:string,token:string,confirmed:boolean,terms:boolean,now:number):{plan:PostSalePlan;job?:PostSaleJob}{
 if(!plan||!confirmed||plan.actor!==actor||plan.token!==token)throw Error('変更内容を確認してください。');
 if(plan.state==='QUEUED'||plan.state==='EXECUTING'&&plan.queuedAt||plan.state==='COMPLETE')return {plan};
 if(plan.state!=='REVIEW'||plan.expiresAt<now||!plan.rows.some(r=>r.state==='READY'))throw Error('最新の変更内容を確認し直してください。');
 if(plan.rows.some(r=>r.state==='READY'&&r.requiresTerms)&&!terms)throw Error('Yahoo!オークションのガイドラインを確認してください。');
 if(plan.rows.some(r=>r.channel===plan.soldChannel&&r.operation!=='RELIST'&&r.operation!=='MANUAL'))throw Error('売れた商品ページは変更できません。');
 const at=new Date(now).toISOString();
 return {plan:{...plan,state:'QUEUED',queuedAt:at,updatedAt:at},job:{id:postSaleJobId(plan.id),candidateId:plan.id,token,actor,terms,state:'SALE_EC_ACTIVE',createdAt:at,updatedAt:at,nextAt:plan.nextAt??0,attempts:0,ttl:Math.floor(now/1000)+30*86400}};
}
export type PostSaleJobPorts={now:()=>number;read:()=>Promise<PostSalePlan|undefined>;execute:(p:PostSalePlan)=>Promise<PostSalePlan>;save:(job:PostSaleJob)=>Promise<void>;attention:(plan:PostSalePlan,reason:string)=>Promise<void>};
/** Invoked by the scheduled worker, never by a browser timer. */
export async function runPostSaleJob(job:PostSaleJob,p:PostSaleJobPorts){
 if(job.state!=='SALE_EC_ACTIVE'||job.nextAt>p.now())return job;
 const finish=async()=>{job.updatedAt=new Date(p.now()).toISOString();await p.save(job);return job;};
 const plan=await p.read();
 const fail=async(reason:string)=>{job.state='SALE_EC_ATTENTION';job.reason=reason;if(plan?.token===job.token)await p.attention(plan,reason);return finish();};
 if(!plan||plan.token!==job.token||plan.actor!==job.actor)return fail('確認内容が変更されています。結果を再確認してください。');
 if(plan.state==='COMPLETE'){job.state='SALE_EC_COMPLETE';return finish();}
 if(plan.state==='ATTENTION')return fail(plan.error??'手動確認が必要な販売先があります。');
 if(plan.state==='EXECUTING'&&(plan.executionLeaseUntil??plan.expiresAt)>p.now()){job.nextAt=plan.executionLeaseUntil??plan.expiresAt;return finish();}
 if(plan.expiresAt<p.now())return fail('確認の有効期限を過ぎました。最新の在庫と出品を再確認してください。');
 try{
  const result=await p.execute(plan);
  if(result.state==='COMPLETE'){job.state='SALE_EC_COMPLETE';delete job.reason;}
  else if(result.state==='QUEUED'||result.state==='EXECUTING'){job.nextAt=result.nextAt??p.now()+30000;delete job.reason;}
  else {job.state='SALE_EC_ATTENTION';job.reason=result.rows.filter(r=>r.state!=='DONE').map(r=>r.message).join(' / ')||'結果を再確認してください。';}
 }catch{
  job.attempts++;
  if(job.attempts>=3)return fail('処理結果を確定できませんでした。再送せず結果を再確認してください。');
  job.nextAt=p.now()+60000;job.reason='接続の回復を待って結果を再確認します。';
 }
 return finish();
}

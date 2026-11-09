import 'server-only';
import {BatchGetCommand,GetCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import outputs from '../../amplify_outputs.json';
import {econveniDatabase as db,ECONVENI_WORKFLOW_TABLE as table} from '../listing/econveni/runtimeStore';
import {candidateStore,candidateConfig} from './store';
import {PostSaleError} from './postSaleCore';
import {approvedPostSaleJob,postSaleJobId} from './postSaleQueueCore';
import type {PostSalePlan} from './postSaleModel';

export async function readPostSaleStatus(id:string):Promise<PostSalePlan|undefined>{
 return (await db.send(new GetCommand({TableName:table,Key:{pk:'SALE_EC#'+id},ConsistentRead:true}))).Item as PostSalePlan|undefined;
}
export async function enqueuePostSale(id:string,actor:string,token:string,confirmed:boolean,terms:boolean){
 const p=await readPostSaleStatus(id);
 let approval;try{approval=approvedPostSaleJob(p,actor,token,confirmed,terms,Date.now());}catch(e){throw new PostSaleError((e as Error).message);}
 if(!approval.job)return approval.plan;
 const candidate=await candidateStore().get(id);
 if(candidate?.state!=='DONE'||candidate.result?.sourceId!==p!.sourceId)throw new PostSaleError('売却結果を確認してください。');
 try{
  await db.send(new TransactWriteCommand({TransactItems:[
   {Update:{TableName:table,Key:{pk:'SALE_EC#'+id},UpdateExpression:'SET #s=:queued,queuedAt=:now,updatedAt=:now',ConditionExpression:'#s=:review AND #t=:token AND actor=:actor AND expiresAt>=:time',ExpressionAttributeNames:{'#s':'state','#t':'token'},ExpressionAttributeValues:{':queued':'QUEUED',':review':'REVIEW',':token':token,':actor':actor,':now':approval.plan.queuedAt,':time':Date.now()}}},
   {Put:{TableName:candidateConfig().tableName,Item:approval.job,ConditionExpression:'attribute_not_exists(id) OR #s<>:active',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':active':'SALE_EC_ACTIVE'}}}
  ]}));
 }catch(e){
  // An acknowledgement can be lost after commit. Return the durable receipt, never enqueue twice.
  const saved=await readPostSaleStatus(id);
  if(saved?.token===token&&saved.actor===actor&&saved.queuedAt&&['QUEUED','EXECUTING','COMPLETE','ATTENTION'].includes(saved.state))return saved;
  throw e;
 }
 // Fast wake-up only. The minute scheduler recovers a lost/failed invocation without browser help.
 const fn=(outputs as unknown as {custom?:{saleAutomation?:{functionName:string}}}).custom?.saleAutomation?.functionName;
 if(fn)try{await new LambdaClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1}).send(new InvokeCommand({FunctionName:fn,InvocationType:'Event',Payload:Buffer.from(JSON.stringify({mode:'POST_SALE'}))}),{abortSignal:AbortSignal.timeout(1200)});}catch{console.warn('POST_SALE_SCHEDULED_FALLBACK');}
 return approval.plan;
}
export async function postSaleJobStatus(ids:string[]){
 if(!ids.length)return {};
 const t=candidateConfig().tableName,keys=[...new Set(ids)].slice(0,80).map(id=>({id:postSaleJobId(id)}));
 const r=await db.send(new BatchGetCommand({RequestItems:{[t]:{Keys:keys,ConsistentRead:true,ProjectionExpression:'candidateId,#s,reason,updatedAt',ExpressionAttributeNames:{'#s':'state'}}}}));
 return Object.fromEntries((r.Responses?.[t]??[]).map(x=>[x.candidateId,x]));
}

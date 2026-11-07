import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import {QueryCommand,TransactWriteCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {SendMessageCommand,SQSClient} from '@aws-sdk/client-sqs';
import {createRuntimeRecord,getRuntimeRecord,inquiryDb,inquirySettings,runtimeConfig,stateFor,type InboxState} from './store';
import {exactInquiryTarget,inquiryReadUrl,readJobKey,validateReadSnapshot,type ReadSnapshot,type ReadTarget} from './readContract';

export type InquiryReadJob=ReadTarget & {pk:string;sk:'STATE';conversationPk:string;version:number;sourceMessageId:string;status:'QUEUED'|'READING'|'DONE'|'BLOCKED'|'STALE';leaseId?:string;leaseUntil?:number;actor?:string;attempts:number;result?:ReadSnapshot;resultDigest?:string;reason?:string};
const safeId=/^READ#[a-f0-9]{64}$/;
const conditional=(e:unknown)=>['ConditionalCheckFailedException','TransactionCanceledException'].includes((e as Error).name);
export async function requestInquiryRead(state:InboxState,sourceMessageId:string,url:string){
  const target=exactInquiryTarget(url),settings=await inquirySettings();
  if(!target||settings.mercariShopId!==target.shopId)throw Error('READ_ACCOUNT_NOT_CONFIGURED');
  const pk=readJobKey(state.pk,state.version,sourceMessageId),now=Date.now();
  await createRuntimeRecord({pk,sk:'STATE',...target,conversationPk:state.pk,version:state.version,sourceMessageId,status:'QUEUED',kind:'READ_QUEUE',lastAt:now,attempts:0,createdAt:new Date(now).toISOString(),ttl:Math.ceil(now/1000)+7*86400});
  return (await getRuntimeRecord(pk)) as InquiryReadJob;
}
/** One lease for the shop AND one for the job; two PCs cannot operate the same shop concurrently. */
export async function claimInquiryRead(actor:string){
  const settings=await inquirySettings();
  if(!settings.enabled||typeof settings.mercariShopId!=='string')return null;
  const table=runtimeConfig().table,now=Date.now();
  const page=await inquiryDb.send(new QueryCommand({TableName:table,IndexName:'recent',KeyConditionExpression:'kind=:kind',ExpressionAttributeValues:{':kind':'READ_QUEUE'},ScanIndexForward:true,Limit:50}));
  for(const row of page.Items??[]){
    const job=await getRuntimeRecord(row.pk) as InquiryReadJob|undefined;
    if(!job||job.shopId!==settings.mercariShopId||!['QUEUED','READING'].includes(job.status)||(job.leaseUntil??0)>now)continue;
    const state=await stateFor(job.conversationPk);
    if(!state||state.version!==job.version||state.mode==='STAFF'){
      await inquiryDb.send(new UpdateCommand({TableName:table,Key:{pk:job.pk,sk:'STATE'},UpdateExpression:'SET #s=:s REMOVE kind',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':'STALE'}}));continue;
    }
    if(job.attempts>=2){await blockRead(job,'READ_RETRY_LIMIT');continue;}
    const leaseId=randomUUID(),leaseUntil=now+180000;
    try{
      await inquiryDb.send(new TransactWriteCommand({TransactItems:[
        {Update:{TableName:table,Key:{pk:'READSESSION#'+job.shopId,sk:'STATE'},UpdateExpression:'SET leaseId=:lease,leaseUntil=:until,actor=:actor',ConditionExpression:'attribute_not_exists(leaseUntil) OR leaseUntil<:now',ExpressionAttributeValues:{':lease':leaseId,':until':leaseUntil,':actor':actor,':now':now}}},
        {Update:{TableName:table,Key:{pk:job.pk,sk:'STATE'},UpdateExpression:'SET #s=:reading,leaseId=:lease,leaseUntil=:until,actor=:actor,attempts=:attempts',ConditionExpression:'#s IN (:queued,:reading) AND (attribute_not_exists(leaseUntil) OR leaseUntil<:now)',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':queued':'QUEUED',':reading':'READING',':lease':leaseId,':until':leaseUntil,':actor':actor,':attempts':job.attempts+1,':now':now}}},
        {ConditionCheck:{TableName:table,Key:{pk:state.pk,sk:'STATE'},ConditionExpression:'#v=:v AND (attribute_not_exists(#m) OR #m<>:staff)',ExpressionAttributeNames:{'#v':'version','#m':'mode'},ExpressionAttributeValues:{':v':job.version,':staff':'STAFF'}}},
      ]}));
      return {jobId:job.pk,leaseId,leaseUntil,shopId:job.shopId,inquiryId:job.inquiryId,url:inquiryReadUrl(job),maxActions:30};
    }catch(e){if(!conditional(e))throw e;}
  }
  return null;
}
async function blockRead(job:InquiryReadJob,reason:string){
  await inquiryDb.send(new UpdateCommand({TableName:runtimeConfig().table,Key:{pk:job.pk,sk:'STATE'},UpdateExpression:'SET #s=:blocked,reason=:reason REMOVE kind,leaseUntil',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':blocked':'BLOCKED',':reason':reason}}));
}
export async function finishInquiryRead(actor:string,jobId:string,leaseId:string,raw:unknown,failure?:string){
  if(!safeId.test(jobId)||typeof leaseId!=='string')throw Error('INVALID_READ_JOB');
  const job=await getRuntimeRecord(jobId) as InquiryReadJob|undefined;
  if(!job||job.actor!==actor||job.leaseId!==leaseId)throw Error('READ_OWNER_REQUIRED');
  if(job.status==='DONE'){await queue(job.conversationPk);return {status:'DONE'};}
  if(job.status!=='READING'||(job.leaseUntil??0)<=Date.now())throw Error('READ_LEASE_EXPIRED');
  const table=runtimeConfig().table,state=await stateFor(job.conversationPk),stale=!state||state.version!==job.version||state.mode==='STAFF';
  const allowed=new Set(['AUTH_REQUIRED','PAGE_CHANGED','PAGE_UNAVAILABLE','TIME_LIMIT','ACTION_LIMIT','INCOMPLETE_HISTORY','READ_FAILED']);
  const reason=stale?'STALE':failure&&allowed.has(failure)?failure:null;
  if(failure&&!reason)throw Error('INVALID_READ_FAILURE');
  const result=reason?null:validateReadSnapshot(raw,job);
  const status=stale?'STALE':reason?'BLOCKED':'DONE';
  await inquiryDb.send(new TransactWriteCommand({TransactItems:[
    {Update:{TableName:table,Key:{pk:job.pk,sk:'STATE'},ConditionExpression:'leaseId=:lease AND actor=:actor AND leaseUntil>:now',UpdateExpression:'SET #s=:status,reason=:reason'+(result?',#result=:result,resultDigest=:digest':'')+' REMOVE kind,leaseUntil',ExpressionAttributeNames:{'#s':'status',...(result?{'#result':'result'}:{})},ExpressionAttributeValues:{':lease':leaseId,':actor':actor,':now':Date.now(),':status':status,':reason':reason??'',...(result?{':result':result,':digest':createHash('sha256').update(JSON.stringify(result)).digest('hex')}:{})}}},
    {Update:{TableName:table,Key:{pk:'READSESSION#'+job.shopId,sk:'STATE'},ConditionExpression:'leaseId=:lease AND actor=:actor',UpdateExpression:'REMOVE leaseId,leaseUntil,actor',ExpressionAttributeValues:{':lease':leaseId,':actor':actor}}},
    ...(!stale?[{Update:{TableName:table,Key:{pk:job.conversationPk,sk:'STATE'},ConditionExpression:'#v=:v AND (attribute_not_exists(#m) OR #m<>:staff)',UpdateExpression:result?'SET processedVersion=:zero,dueAt=:now,#r=:queued REMOVE lockOwner,lockUntil':'SET #r=:blocked,reason=:reason',ExpressionAttributeNames:{'#v':'version','#m':'mode','#r':'result'},ExpressionAttributeValues:{':v':job.version,':staff':'STAFF',...(result?{':zero':0,':now':Date.now(),':queued':'QUEUED'}:{':blocked':'TECHNICAL_BLOCK',':reason':reason==='AUTH_REQUIRED'?'メルカリ確認用ブラウザへのログインが必要です。受信内容は保持しています。':'問い合わせ画面を取得できませんでした。接続を確認して再試行できます。'})}}}]:[]),
  ]}));
  if(result)await queue(job.conversationPk);
  return {status};
}
async function queue(pk:string){const c=runtimeConfig();await new SQSClient({region:c.region}).send(new SendMessageCommand({QueueUrl:c.queueUrl,MessageBody:JSON.stringify({pk})}));}
export async function retryInquiryRead(pk:string){
  const state=await stateFor(pk);if(!state?.lastEventSk)throw Error('READ_NOT_FOUND');
  const event=await getRuntimeRecord(pk,state.sourceEventSk??state.lastEventSk);
  const params=event?.payload?.channel==='MERCARI_SHOPS'?event.payload.params:null;
  if(!params?.sourceMessageId||!params.mercariInquiryUrl)throw Error('READ_NOT_FOUND');
  const job=await requestInquiryRead(state,params.sourceMessageId,params.mercariInquiryUrl);
  if(job.status==='READING'&&(job.leaseUntil??0)>Date.now())throw Error('READ_IN_PROGRESS');
  await inquiryDb.send(new UpdateCommand({TableName:runtimeConfig().table,Key:{pk:job.pk,sk:'STATE'},ConditionExpression:'#s<>:reading OR leaseUntil<:now',UpdateExpression:'SET #s=:queued,kind=:kind,lastAt=:now,attempts=:zero REMOVE leaseId,leaseUntil,actor,reason',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':reading':'READING',':now':Date.now(),':queued':'QUEUED',':kind':'READ_QUEUE',':zero':0}}));
}

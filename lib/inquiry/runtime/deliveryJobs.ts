import 'server-only';
import {randomUUID} from 'node:crypto';
import {GetCommand,TransactWriteCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {SendMessageCommand,SQSClient} from '@aws-sdk/client-sqs';
import {getConversation,listMessages} from '@/lib/messaging/service';
import {getReplyDraft} from '@/lib/inquiry/draftStore';
import {directTableName} from '@/lib/amplify/directData';
import {runWithDirectData} from '@/lib/amplify/dataClient';
import {CUSTOMER_DELIVERY_ENABLED} from '@/lib/messaging/featureState';
import {conversationStamp} from './policy';
import {deliveryFingerprint,deliveryJobId,evaluatedDeliveryAllowed,recentDraftProof,type DeliveryPolicy} from './deliveryPolicy';
import {sendCustomerMessage,type CustomerTarget} from './customerTransport';
import {createRuntimeRecord,getRuntimeRecord,inquiryDb,inquirySettings,runtimeConfig,stateFor} from './store';
import {exactInquiryTarget,readJobKey,type ReadSnapshot} from './readContract';
import {detectUnverifiedFulfillment} from '../fulfillmentSafety';

type SendJob={pk:string;sk:'STATE';conversationPk:string;conversationId:string;version:number;draftId:string;draftVersion:string;sourceMessageId:string;destinationHash:string;bodyHash:string;manual:boolean;actor:string;retryKey:string;status:string;expiresAt:number;leaseUntil?:number};
async function deliveryInputs(pk:string,draftId:string){
  const state=await stateFor(pk);if(!state?.conversationId||!state.sourceEventSk)throw Error('SOURCE_MISSING');
  const [draft,conversation,messages,event]=await Promise.all([getReplyDraft(draftId),getConversation(state.conversationId),listMessages(state.conversationId),getRuntimeRecord(pk,state.sourceEventSk)]);
  if(!draft||draft.conversationId!==state.conversationId||!conversation||!event)throw Error('SOURCE_MISMATCH');
  let target:CustomerTarget;
  if(event.payload?.channel==='LINE'&&conversation.channel==='LINE'){
    const customer=event.payload.event?.source?.userId;
    if(!customer||customer!==conversation.externalCustomerId)throw Error('DESTINATION_MISMATCH');
    target={channel:'LINE',account:event.payload.account,recipient:customer};
  }else if(event.payload?.channel==='MERCARI_SHOPS'&&conversation.channel==='MERCARI_SHOPS'){
    const exact=exactInquiryTarget(event.payload.params?.mercariInquiryUrl);
    if(!exact)throw Error('DESTINATION_MISSING');
    target={channel:'MERCARI_SHOPS',account:exact.shopId,recipient:exact.inquiryId};
  }else throw Error('UNSUPPORTED_CHANNEL');
  return {state,draft,conversation,messages,target};
}
async function fresh(input:Awaited<ReturnType<typeof deliveryInputs>>,manual:boolean){
  const {state,draft,conversation,messages}=input,proof=draft.evidence?.runtimeProof;
  if(state.version!==state.processedVersion||(!manual&&state.mode==='STAFF')||draft.status!=='READY'||!draft.draftText?.trim()||draft.unresolvedFacts.length||draft.evidence?.humanHandoff?.required||!proof||!recentDraftProof(proof.generatedAt))return false;
  // External prices, shipping arrangements and negotiation need a separate human review.
  // They are never covered merely by a product-record version check.
  if(!manual&&(detectUnverifiedFulfillment(draft.draftText).length||draft.evidence?.externalFacts.length||draft.evidence?.shipping||draft.evidence?.baseProducts?.length||draft.evidence?.channelProduct?.orderId||draft.evidence?.negotiation?.detected||draft.evidence?.inventorySyncSuspected))return false;
  if(proof.conversationStamp!==conversationStamp(conversation,messages))return false;
  const latest=messages.filter(m=>m.direction==='INBOUND'&&m.body!=='[送信取消]').sort((a,b)=>(b.externalSentAt??b.createdAt).localeCompare(a.externalSentAt??a.createdAt))[0];
  if(!latest||latest.id!==draft.sourceMessageId||(conversation.lastOutgoingAt&&(latest.externalSentAt??latest.createdAt)<=conversation.lastOutgoingAt))return false;
  const product=draft.evidence?.inventoryVersion;
  if(draft.resolvedInventoryId&&(!product||product.id!==draft.resolvedInventoryId))return false;
  if(product){const row=(await inquiryDb.send(new GetCommand({TableName:directTableName('Inventory'),Key:{id:product.id},ConsistentRead:true}))).Item;if(!row||row.updatedAt!==product.updatedAt)return false;}
  for(const rule of draft.evidence?.appliedReplyRules??[]){const row=(await inquiryDb.send(new GetCommand({TableName:directTableName('ReplyRule'),Key:{id:rule.id},ConsistentRead:true}))).Item;if(!row||row.version!==rule.version||row.enabled===false)return false;}
  for(const doc of draft.evidence?.knowledgeDocuments??[]){const row=(await inquiryDb.send(new GetCommand({TableName:directTableName('KnowledgeDocument'),Key:{id:doc.id},ConsistentRead:true}))).Item;if(!doc.updatedAt||!row||row.updatedAt!==doc.updatedAt||!row.isActive||!row.aiReferenceEnabled)return false;}
  return true;
}
/** The destination is derived from the signed inbound event, never from a browser input. */
export async function enqueueCustomerDelivery(pk:string,draftId:string,expectedDraftVersion:string,actor:string,manual=true){
  const settings=await inquirySettings();
  if(!CUSTOMER_DELIVERY_ENABLED)throw Error('DELIVERY_DISABLED');
  const input=await deliveryInputs(pk,draftId),policy=(settings.delivery??{mode:'DRAFT',approvedIntents:[]}) as DeliveryPolicy;
  if(!settings.enabled||!evaluatedDeliveryAllowed(policy,input.draft.intents,manual))throw Error('DELIVERY_NOT_EVALUATED');
  if(input.draft.updatedAt!==expectedDraftVersion||!await fresh(input,manual))throw Error('STALE_DRAFT');
  const destinationHash=deliveryFingerprint(input.target),id=deliveryJobId(input.conversation.id,input.draft.sourceMessageId,draftId,expectedDraftVersion,destinationHash),now=Date.now();
  await createRuntimeRecord({pk:id,sk:'STATE',conversationPk:pk,conversationId:input.conversation.id,version:input.state.version,draftId,draftVersion:expectedDraftVersion,sourceMessageId:input.draft.sourceMessageId,destinationHash,bodyHash:deliveryFingerprint(input.draft.draftText),manual,actor,retryKey:randomUUID(),status:'QUEUED',createdAt:new Date(now).toISOString(),expiresAt:now+300000,ttl:Math.ceil(now/1000)+30*86400});
  await inquiryDb.send(new UpdateCommand({TableName:runtimeConfig().table,Key:{pk,sk:'STATE'},ConditionExpression:'#v=:v',UpdateExpression:'SET lastDeliveryJobId=:job',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':input.state.version,':job':id}}));
  const c=runtimeConfig();await new SQSClient({region:c.region}).send(new SendMessageCommand({QueueUrl:c.queueUrl,MessageBody:JSON.stringify({action:'SEND',pk:id})}));
  return {jobId:id,status:(await getRuntimeRecord(id))?.status};
}
export async function runCustomerDelivery(pk:string){
  if(!/^SEND#[a-f0-9]{64}$/.test(pk))throw Error('INVALID_SEND_JOB');
  const job=await getRuntimeRecord(pk) as SendJob|undefined;if(!job)return;
  if(job.status==='SENDING'){
    if((job.leaseUntil??0)<Date.now())await finishStatus(job,'UNKNOWN');
    else throw Error('DELIVERY_IN_PROGRESS');
    return; // A crash after transmission must not cause an automatic resend.
  }
  if(job.status!=='QUEUED')return;
  const settings=await inquirySettings(),policy=(settings.delivery??{mode:'DRAFT',approvedIntents:[]}) as DeliveryPolicy;
  if(!CUSTOMER_DELIVERY_ENABLED||!settings.enabled||job.expiresAt<Date.now()){await finishStatus(job,'CANCELLED');return;}
  const load=()=>runWithDirectData(()=>deliveryInputs(job.conversationPk,job.draftId));
  const check=async()=>{
    const current=await load();
    const currentSettings=await inquirySettings();
    return currentSettings.enabled&&evaluatedDeliveryAllowed((currentSettings.delivery??{mode:'DRAFT',approvedIntents:[]}) as DeliveryPolicy,current.draft.intents,job.manual)&&current.state.version===job.version&&current.draft.updatedAt===job.draftVersion&&deliveryFingerprint(current.target)===job.destinationHash&&deliveryFingerprint(current.draft.draftText)===job.bodyHash&&await fresh(current,job.manual);
  };
  const input=await load();
  if(!evaluatedDeliveryAllowed(policy,input.draft.intents,job.manual)||!await check()){await finishStatus(job,'CANCELLED');return;}
  const table=runtimeConfig().table;
  try{await inquiryDb.send(new TransactWriteCommand({TransactItems:[
    {Update:{TableName:table,Key:{pk,sk:'STATE'},ConditionExpression:'#s=:queued',UpdateExpression:'SET #s=:sending,leaseUntil=:until',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':queued':'QUEUED',':sending':'SENDING',':until':Date.now()+90000}}},
    {ConditionCheck:{TableName:table,Key:{pk:job.conversationPk,sk:'STATE'},ConditionExpression:'#v=:v AND processedVersion=:v'+(!job.manual?' AND (attribute_not_exists(#m) OR #m<>:staff)':''),ExpressionAttributeNames:{'#v':'version',...(!job.manual?{'#m':'mode'}:{})},ExpressionAttributeValues:{':v':job.version,...(!job.manual?{':staff':'STAFF'}:{})}}},
    {Put:{TableName:table,Item:{pk:'REPLYSLOT#'+deliveryFingerprint([job.conversationId,job.sourceMessageId]),sk:'STATE',jobId:pk,ttl:Math.ceil(Date.now()/1000)+30*86400},ConditionExpression:'attribute_not_exists(pk)'}},
  ]}));}catch(e){if((e as Error).name==='TransactionCanceledException'){
    const slot=await getRuntimeRecord('REPLYSLOT#'+deliveryFingerprint([job.conversationId,job.sourceMessageId]));
    if(slot&&slot.jobId!==pk)await finishStatus(job,'CANCELLED');
    else if(!slot)await finishStatus(job,'CANCELLED');
    return;
  }throw e;}
  try{
    const remote=input.target.channel==='MERCARI_SHOPS'?(await getRuntimeRecord(readJobKey(job.conversationPk,job.version,job.sourceMessageId)))?.result as ReadSnapshot|undefined:undefined;
    const sent=await sendCustomerMessage(input.target,input.draft.draftText!,job.retryKey,check,remote);
    if(sent.status!=='ACCEPTED'){await finishStatus(job,sent.status);return;}
    const now=new Date().toISOString();
    await inquiryDb.send(new TransactWriteCommand({TransactItems:[
      {Update:{TableName:table,Key:{pk,sk:'STATE'},ConditionExpression:'#s=:sending',UpdateExpression:'SET #s=:accepted,acceptedAt=:now,receipt=:receipt REMOVE leaseUntil',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':sending':'SENDING',':accepted':'ACCEPTED',':now':now,':receipt':sent.receipt??''}}},
      {Put:{TableName:directTableName('Message'),Item:{id:pk,conversationId:job.conversationId,direction:'OUTBOUND',senderType:job.manual?'STAFF':'AI',body:input.draft.draftText,contentType:'text',deliveryStatus:'SENT',externalSentAt:now,externalMessageId:sent.receipt,createdAt:now,updatedAt:now,createdBy:job.actor},ConditionExpression:'attribute_not_exists(id)'}},
      {Update:{TableName:directTableName('Conversation'),Key:{id:job.conversationId},UpdateExpression:'SET lastOutgoingAt=:now,updatedAt=:now',ExpressionAttributeValues:{':now':now}}},
    ]}));
  }catch{await finishStatus(job,'UNKNOWN');}
}
async function finishStatus(job:SendJob,status:string){
  try{await inquiryDb.send(new UpdateCommand({TableName:runtimeConfig().table,Key:{pk:job.pk,sk:'STATE'},ConditionExpression:'#s IN (:queued,:sending)',UpdateExpression:'SET #s=:s,updatedAt=:now REMOVE leaseUntil',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':queued':'QUEUED',':sending':'SENDING',':s':status,':now':new Date().toISOString()}}));}
  catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
}

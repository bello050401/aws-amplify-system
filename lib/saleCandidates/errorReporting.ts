import {createHash} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand} from '@aws-sdk/lib-dynamodb';
import {SystemErrorQueue,type ErrorQueueConfig} from '../systemErrors/queue';
import type {SystemErrorSignal} from '../systemErrors/contract';

/** Reasons are classified locally; error messages, order/customer data, URLs,
 * access tokens and photos never enter the repair intake. */
export function saleFailureSignal(phase:string,reason:string):SystemErrorSignal|null {
 if(reason==='MERCARI_ORDER_ALREADY_RECORDED')return null;
 if(['WAITING_PAYMENT','MERCARI_DESKTOP_WAITING','MERCARI_DESKTOP_VERIFICATION','MERCARI_ORDER_CONTEXT_REQUIRED','MERCARI_IDENTIFICATION_REVIEW','PRE_SALE_WAITING','PREVIOUS_SALE_PENDING','STOCK_LOCKED','HISTORICAL','CANDIDATE_REMOVED','QUANTITY_UNKNOWN','SET_REVIEW','ORDER_REVIEW','NOT_UNIQUE','NO_ITEM_ID','UNTRUSTED_MAIL','STOCK_CHANGED','CANCELLED','CHANNEL_UNSUPPORTED'].includes(reason))return null;
 const code=/AUTH_REQUIRED|ACCESS_DENIED|SESSION_EXPIRED|ADDITIONAL_AUTH|PERMISSION/.test(reason)?'SALE_AUTH_REQUIRED':/RATE_LIMITED|CAPACITY|WAIT_INTERVAL/.test(reason)?'SALE_RATE_LIMITED':/FORM_CHANGED/.test(reason)?'SALE_REMOTE_FORMAT_CHANGED':/ECONVENI|BINDING|LINK/.test(reason)?'SALE_LINK_FAILED':/DESKTOP|MERCARI_IDENTITY/.test(reason)?'SALE_DESKTOP_FAILED':/EC_RESULT|VERIFY_REQUIRED|UNCONFIRMED/.test(reason)?'SALE_EC_UNCONFIRMED':'SALE_AUTOMATION_FAILED';
 return {code,surface:'server',operation:phase==='IDENTIFY'?'identify':phase==='SALE'?'sell':phase==='EC'?'adjust':'verify',component:code==='SALE_DESKTOP_FAILED'?'sale-desktop':'sale-automation',errorClass:'Error'};
}
export function saleErrorReceipt(candidateId:string,phase:string,reason:string){
 if(!/^[a-f0-9]{64}$/.test(candidateId)||!['IDENTIFY','WAITING','REVIEW','SALE','EC','COMPLETE'].includes(phase)||!/^[A-Za-z0-9_]{1,100}$/.test(reason))throw Error('INVALID_SALE_DIAGNOSTIC');
 return 'SALE_ERROR:'+createHash('sha256').update(JSON.stringify([candidateId,phase,reason])).digest('hex');
}
/** SSR supplies its compiled release; workers use the release pinned in their
 * deployment environment. Mutable automation settings are never code identity. */
export function saleDiagnosticRelease(compiledRelease?:unknown,environmentRelease?:unknown):string|null {
 const release=compiledRelease??environmentRelease??'unknown';
 return typeof release==='string'&&/^(?:[a-f0-9]{7,40}|unknown)$/.test(release)?release:null;
}
export async function reportSaleAutomationFailure(candidateId:string,phase:string,reason:string,candidateTable?:string,compiledRelease?:string):Promise<boolean>{
 try{
  const signal=saleFailureSignal(phase,reason);if(!signal)return false;
  const table=candidateTable||process.env.SALE_CANDIDATES_TABLE;if(!table)return false;
  const id=saleErrorReceipt(candidateId,phase,reason),db=DynamoDBDocumentClient.from(new DynamoDBClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1}));
  if((await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item)return true;
  const config=(await db.send(new GetCommand({TableName:table,Key:{id:'AUTOMATION_CONFIG'},ConsistentRead:true}))).Item?.systemErrors as ErrorQueueConfig|undefined;
  if(!config||!/^[A-Za-z0-9_.-]{3,255}$/.test(config.table)||config.region!==(process.env.AWS_REGION||'us-west-2'))return false;
  const release=saleDiagnosticRelease(compiledRelease,process.env.BELLO_SYSTEM_ERRORS_RELEASE);
  if(!release)return false;
  return (await new SystemErrorQueue({...config,release},db).enqueue(signal,'sale-worker',Date.now(),AbortSignal.timeout(3000),{table,id})).accepted;
 }catch{return false;}
}

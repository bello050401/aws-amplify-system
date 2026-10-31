import {GetCommand,PutCommand,QueryCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {InventoryTransaction} from '../inventory/categoryPersistenceCore';
import type {SoldOutResult} from '../inventory/soldOutInput';
import {DEFAULT_FEES,currentFeeConfig,type SaleCandidate,type FeeConfig,validateFeeConfig} from './model';
import {mergeYahooNotification} from './yahooMail';
import {yahooPaymentPlan,yahooPaymentKey,YAHOO_PAYMENT_QUEUE_STATE} from './yahooPaymentModel';
import {deletedCandidateRecord,type DeletedSaleCandidate} from './deletion';
export function createCandidateStore(db:DynamoDBDocumentClient,table:string){
 const get=async(id:string)=>(await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item;
 return {
  get:async(id:string):Promise<SaleCandidate|undefined>=>{const row=await get(id);return row?.state==='DELETED'?undefined:row as SaleCandidate|undefined;},
  put:async(value:SaleCandidate)=>{try{await db.send(new PutCommand({TableName:table,Item:value,ConditionExpression:'attribute_not_exists(id)'}));return true;}catch(e){if((e as Error).name==='ConditionalCheckFailedException')return false;throw e;}},
  receiveYahoo:async(value:SaleCandidate):Promise<'created'|'updated'|'unchanged'>=>{
   for(let attempt=0;attempt<5;attempt++){
    const current=await get(value.id) as SaleCandidate|undefined;
    if(current?.state==='DELETED')return 'unchanged';
    const next=current?mergeYahooNotification(current,value):value;
    if(next===current)return 'unchanged';
    try{
     // Compare state and version so a concurrent sale/delete cannot be overwritten by a mail refresh.
     await db.send(new PutCommand({TableName:table,Item:next,ConditionExpression:current?'updatedAt=:version AND #s=:state':'attribute_not_exists(id)',...(current?{ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':version':current.updatedAt,':state':current.state}}:{})}));
     return current?'updated':'created';
    }catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
   }
   throw Error('YAHOO_CONCURRENT_UPDATE');
  },
  list:async(state:SaleCandidate['state'],cursor?:string)=>{
   let key;try{key=cursor?JSON.parse(Buffer.from(cursor,'base64url').toString()):undefined;}catch{throw Error('INVALID_CURSOR');}
   if(key&&(typeof key.id!=='string'||key.state!==state||typeof key.receivedAt!=='string'))throw Error('INVALID_CURSOR');
   const r=await db.send(new QueryCommand({TableName:table,IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':state},ScanIndexForward:false,Limit:30,ExclusiveStartKey:key}));
   return {items:(r.Items||[]) as SaleCandidate[],cursor:r.LastEvaluatedKey?Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString('base64url'):null};
  },
  remove:async(id:string,actor:string)=>{
   const current=await get(id) as SaleCandidate|DeletedSaleCandidate|undefined;
   if(!current)return;
   const next=deletedCandidateRecord(current,actor,new Date().toISOString());
   // Atomic replacement scrubs even legacy fields. A concurrent confirmation or
   // notification refresh must not be overwritten by the deletion.
   await db.send(new PutCommand({TableName:table,Item:next,ConditionExpression:'#s=:state AND updatedAt=:version',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':state':current.state,':version':current.updatedAt}}));
  },
  commit:(candidate:SaleCandidate,actor:string,result:SoldOutResult,now:string):InventoryTransaction=>{
   const payment=yahooPaymentPlan(candidate);
   const writes:InventoryTransaction=[{Update:{TableName:table,Key:{id:candidate.id},UpdateExpression:'SET #s=:done, #r=:result,completedBy=:actor,completedAt=:now,updatedAt=:now'+(payment?',yahooPaymentState=:payment':'')+(payment&&!payment.waiting?',yahooPaymentAppliedAt=:now':''),ConditionExpression:'#s=:pending AND updatedAt=:version',ExpressionAttributeNames:{'#s':'state','#r':'result'},ExpressionAttributeValues:{':pending':'PENDING',':done':'DONE',':result':result,':actor':actor,':now':now,':version':candidate.updatedAt,...(payment?{':payment':payment.waiting?'WAITING':'APPLIED'}:{})}}}];
   if(payment?.waiting)writes.push({Put:{TableName:table,Item:{id:yahooPaymentKey(candidate.id),state:YAHOO_PAYMENT_QUEUE_STATE,receivedAt:now,candidateId:candidate.id,auctionId:payment.auctionId,...result},ConditionExpression:'attribute_not_exists(id)'}});
   return writes;
  },
  config:async():Promise<FeeConfig>=>{const r=await get('CONFIG');return r?.fees?currentFeeConfig(validateFeeConfig(r.fees)):DEFAULT_FEES;},
  configure:async(fees:unknown,actor:string)=>db.send(new PutCommand({TableName:table,Item:{id:'CONFIG',fees:currentFeeConfig(validateFeeConfig(fees)),updatedBy:actor,updatedAt:new Date().toISOString()}})),
  status:()=>get('IMPORT_STATUS'),
  baseStatus:()=>get('BASE_IMPORT_STATUS'),
 };
}

// Shared by the server-only web wrapper and the standalone Lambda worker.
import {GetCommand,PutCommand,ScanCommand,UpdateCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {randomUUID} from 'node:crypto';



import {parseBaseOrder} from './baseOrders';
import {candidateKey} from './mailParser';

export async function importBaseOrdersCore(db:DynamoDBDocumentClient,table:string,getAccessToken:()=>Promise<string>,transport:typeof fetch=fetch){
 const owner=randomUUID(),now=Date.now();
 const previous=(await db.send(new GetCommand({TableName:table,Key:{id:'BASE_IMPORT_STATUS'},ConsistentRead:true}))).Item;
 if(previous?.lastAttemptAt&&now-Date.parse(previous.lastAttemptAt)<240000&&!previous.error)return {ok:true,created:0,skipped:true};
 try{await db.send(new UpdateCommand({TableName:table,Key:{id:'BASE_IMPORT_LOCK'},UpdateExpression:'SET ownerId=:o,expiresAt=:e',ConditionExpression:'attribute_not_exists(expiresAt) OR expiresAt<:n',ExpressionAttributeValues:{':o':owner,':e':now+180000,':n':now}}));}catch(e){if((e as Error).name==='ConditionalCheckFailedException')return {ok:true,busy:true,created:0};throw e;}
 const jst=(t:number)=>new Date(t+9*3600000).toISOString().slice(0,19).replace('T',' ');
 let created=0,offset=Number(previous?.offset||0);const start=previous?.start??jst(Math.min(now-7*86400000,previous?.lastCompletedAt?Date.parse(previous.lastCompletedAt)-86400000:now)),end=previous?.end??jst(now);
 try{
  const token=await getAccessToken();
  const read=async(path:string)=>{
   if(!/^\/orders\?(?:[^#]*)$|^\/orders\/detail\/[A-Za-z0-9_-]+$/.test(path))throw Error('BASE_ORDER_ENDPOINT');
   const response=await transport('https://api.thebase.in/1'+path,{headers:{Authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
   if([401,403].includes(response.status))throw Error('BASE_ORDERS_AUTH_REQUIRED');
   if(!response.ok)throw Error('BASE_ORDERS_READ_FAILED');const v=await response.json();if(v.error||v.errors)throw Error('BASE_ORDERS_AUTH_REQUIRED');return v;
  };
  const page=await read('/orders?'+new URLSearchParams({start_ordered:String(start),end_ordered:String(end),offset:String(offset),limit:'10'}));
  if(!Array.isArray(page.orders))throw Error('BASE_ORDER_FORMAT');
  for(const order of page.orders){
   if(typeof order.unique_key!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(order.unique_key))throw Error('BASE_ORDER_FORMAT');
   const marker='BASE_ORDER:'+candidateKey('BASE',order.unique_key,'order');
   if((await db.send(new GetCommand({TableName:table,Key:{id:marker},ConsistentRead:true}))).Item){offset++;continue;}
   // Existing email-derived orders are not re-created under another line identifier.
   let key:Record<string,unknown>|undefined,legacy=false;
   do{const r=await db.send(new ScanCommand({TableName:table,ExclusiveStartKey:key,FilterExpression:'channel=:c AND orderId=:o',ExpressionAttributeValues:{':c':'BASE',':o':order.unique_key},ProjectionExpression:'id'}));legacy ||=!!r.Items?.length;key=r.LastEvaluatedKey;}while(key&&!legacy);
   const candidates=legacy?[]:parseBaseOrder(await read('/orders/detail/'+order.unique_key));
   // A cancelled/empty response is revisited on the next bounded walk.
   if(candidates.length||legacy){await db.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:table,Item:{id:marker,createdAt:new Date().toISOString(),legacy},ConditionExpression:'attribute_not_exists(id)'}},...candidates.map(c=>({Put:{TableName:table,Item:c,ConditionExpression:'attribute_not_exists(id)'}}))]}));created+=candidates.length;}
   offset++;
  }
  const complete=page.orders.length<10;
  await db.send(new PutCommand({TableName:table,Item:{id:'BASE_IMPORT_STATUS',lastAttemptAt:new Date().toISOString(),lastSuccessAt:new Date().toISOString(),lastCompletedAt:complete?new Date().toISOString():previous?.lastCompletedAt??null,created,...(!complete?{offset,start,end}:{})}}));
  return {ok:true,created,more:!complete};
 }catch(e){const code=(e as Error).message==='BASE_ORDERS_AUTH_REQUIRED'?'BASE_ORDERS_AUTH_REQUIRED':'BASE_ORDERS_READ_FAILED';await db.send(new PutCommand({TableName:table,Item:{id:'BASE_IMPORT_STATUS',lastAttemptAt:new Date().toISOString(),lastSuccessAt:previous?.lastSuccessAt??null,lastCompletedAt:previous?.lastCompletedAt??null,error:code,offset,start,end}}));return {ok:false,created,code};}
 finally{await db.send(new UpdateCommand({TableName:table,Key:{id:'BASE_IMPORT_LOCK'},UpdateExpression:'SET expiresAt=:z',ConditionExpression:'ownerId=:o',ExpressionAttributeValues:{':z':0,':o':owner}}));}
}

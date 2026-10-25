import {GetCommand,PutCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {randomUUID} from 'node:crypto';
import {purchaseGmailReader} from './mailReader';
import {parsePurchaseMail,PURCHASE_QUERY} from './mailParser';
import {createCandidateStore} from './storeCore';
// This process has no inventory access and cannot send or alter Gmail messages.
export async function importPurchases(db:DynamoDBDocumentClient,table:string,readerFactory=purchaseGmailReader){
 const owner=randomUUID(),now=Date.now();const state=await db.send(new GetCommand({TableName:table,Key:{id:'IMPORT_STATUS'},ConsistentRead:true}));
 if(state.Item?.lastAttemptAt&&now-Date.parse(state.Item.lastAttemptAt)<240000)return {ok:true,skipped:true};
 try{await db.send(new UpdateCommand({TableName:table,Key:{id:'IMPORT_LOCK'},UpdateExpression:'SET ownerId=:owner,expiresAt=:expires',ConditionExpression:'attribute_not_exists(expiresAt) OR expiresAt<:now',ExpressionAttributeValues:{':owner':owner,':expires':now+180000,':now':now}}));}catch(e){if((e as Error).name==='ConditionalCheckFailedException')return {ok:true,busy:true};throw e;}
 let created=0,checked=0,nextPage:string|undefined=state.Item?.nextPage;
 let pendingIds:string[]=state.Item?.pendingIds||[],complete=false;
 const scanAfter=Math.min(now-7*86400000,state.Item?.lastCompletedAt?Date.parse(state.Item.lastCompletedAt)-86400000:now);
 const scanQuery=state.Item?.scanQuery||PURCHASE_QUERY.replace('newer_than:7d','after:'+Math.floor(scanAfter/1000));
 try{
  const reader=await readerFactory(),store=createCandidateStore(db,table);
  // Resume a bounded walk instead of repeatedly fetching only the newest 50.
  do{
   if(!pendingIds.length){const page=await reader.list(scanQuery,nextPage);pendingIds=(page.messages||[]).map((m:{id:string})=>m.id);nextPage=page.nextPageToken;}
   while(pendingIds.length&&Date.now()-now<25000){
    const id=pendingIds[0],key='MAIL:'+id;const previous=await db.send(new GetCommand({TableName:table,Key:{id:key},ConsistentRead:true}));
    if(!previous.Item){
     const parsed=parsePurchaseMail(await reader.read(id));
     // BASE is read from its official orders API; never create a second email-derived order.
     for(const candidate of parsed.filter(c=>c.channel==='MERCARI'))if(await store.put(candidate))created++;
     await db.send(new PutCommand({TableName:table,Item:{id:key,checkedAt:new Date().toISOString(),ttl:Math.floor(Date.now()/1000)+30*86400}}));checked++;
    }
    pendingIds.shift();
   }
   if(!pendingIds.length&&!nextPage){complete=true;break;}
  }while(Date.now()-now<25000);
  await db.send(new PutCommand({TableName:table,Item:{id:'IMPORT_STATUS',lastAttemptAt:new Date().toISOString(),lastSuccessAt:new Date().toISOString(),lastCompletedAt:complete?new Date().toISOString():state.Item?.lastCompletedAt||null,created,checked,...(!complete?{pendingIds,scanQuery,...(nextPage?{nextPage}:{})}:{})}}));
  return {ok:true,created,checked};
 }catch(e){
  const code=/^GMAIL_/.test((e as Error).message)?(e as Error).message:'IMPORT_FAILED';
  await db.send(new PutCommand({TableName:table,Item:{id:'IMPORT_STATUS',lastAttemptAt:new Date().toISOString(),lastCompletedAt:state.Item?.lastCompletedAt||null,pendingIds,scanQuery,...(nextPage?{nextPage}:{}),lastSuccessAt:state.Item?.lastSuccessAt||null,error:code}}));
  return {ok:false,code};
 }finally{await db.send(new UpdateCommand({TableName:table,Key:{id:'IMPORT_LOCK'},UpdateExpression:'SET expiresAt=:zero',ConditionExpression:'ownerId=:owner',ExpressionAttributeValues:{':zero':0,':owner':owner}}));}
}

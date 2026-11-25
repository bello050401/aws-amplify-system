import {GetCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {InventoryTransaction} from '../inventory/categoryPersistenceCore';
const key=(inventoryId:string)=>({id:'AUTOMATION_STOCK_LOCK:'+inventoryId});
/** No timed takeover: an uncertain EC outcome keeps the stock reserved for reconciliation. */
export async function claimAutomationStock(db:DynamoDBDocumentClient,table:string,inventoryId:string,candidateId:string){
 const existing=(await db.send(new GetCommand({TableName:table,Key:key(inventoryId),ConsistentRead:true}))).Item;
 const owner=existing?.candidateId as string|undefined;
 if(owner&&owner!==candidateId){
  const [job,candidate]=await Promise.all(['AUTO:'+owner,owner].map(id=>db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))));
  const unused=existing?.saleStarted!==true&&(!candidate.Item||['DELETED','ARCHIVED'].includes(candidate.Item.state)||job.Item?.reason==='CANCELLED');
  if(job.Item?.state!=='SALE_AUTO_COMPLETE'&&!unused)return false;
 }
 const takeover=!!owner&&owner!==candidateId;
 const observed=existing?.saleStarted;
 try{await db.send(new UpdateCommand({TableName:table,Key:key(inventoryId),UpdateExpression:'SET candidateId=:id'+(owner===candidateId?'':',saleStarted=:no'),ConditionExpression:(owner?'candidateId=:owner':'attribute_not_exists(candidateId)')+(takeover?(observed===undefined?' AND attribute_not_exists(saleStarted)':' AND saleStarted=:observed'):''),ExpressionAttributeValues:{':id':candidateId,...(owner?{':owner':owner}:{}),...(owner===candidateId?{}:{':no':false}),...(takeover&&observed!==undefined?{':observed':observed}:{})}}));return true;}
 catch(e){if((e as Error).name==='ConditionalCheckFailedException')return false;throw e;}
}
export function automationStockGuard(table:string,inventoryId:string,candidateId:string):InventoryTransaction{
 return [{Update:{TableName:table,Key:key(inventoryId),UpdateExpression:'SET saleStarted=:yes',ConditionExpression:'candidateId=:id',ExpressionAttributeValues:{':id':candidateId,':yes':true}}}];
}
/** Unlisted direct sales have no external continuation; release in the sale commit. */
export function unlistedSaleStockGuard(table:string,inventoryId:string,candidateId?:string):InventoryTransaction{
 return candidateId?[{Update:{TableName:table,Key:key(inventoryId),UpdateExpression:'SET saleStarted=:yes REMOVE candidateId',ConditionExpression:'candidateId=:id',ExpressionAttributeValues:{':id':candidateId,':yes':true}}}]:[{ConditionCheck:{TableName:table,Key:key(inventoryId),ConditionExpression:'attribute_not_exists(candidateId)'}}];
}
export async function releaseAutomationStock(db:DynamoDBDocumentClient,table:string,inventoryId:string,candidateId:string){
 try{await db.send(new UpdateCommand({TableName:table,Key:key(inventoryId),UpdateExpression:'REMOVE candidateId',ConditionExpression:'candidateId=:id',ExpressionAttributeValues:{':id':candidateId}}));}
 catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
}
export async function automationStockOwner(db:DynamoDBDocumentClient,table:string,inventoryId:string){return (await db.send(new GetCommand({TableName:table,Key:key(inventoryId),ConsistentRead:true}))).Item?.candidateId as string|undefined;}

import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,QueryCommand,DeleteCommand,GetCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({}));
/** No TTL on live undo references. Only unreferenced operation metadata older
 * than the retry window is removed. Continue large sweeps on the next run. */
export async function handler(){
 const table=process.env.INVENTORY_EDIT_JOBS_TABLE!,key={pk:'MAINTENANCE',sk:'OPERATION_CURSOR'};
 const state=(await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}))).Item;
 let cursor=state?.cursor,checked=0,removed=0;
 const deadline=Date.now()+45000,cutoff=new Date(Date.now()-8*86400000).toISOString();
 do{
  const page=await db.send(new QueryCommand({TableName:table,IndexName:'ByKind',KeyConditionExpression:'#k=:kind AND createdAt<:before',ExpressionAttributeNames:{'#k':'kind'},ExpressionAttributeValues:{':kind':'OPERATION',':before':cutoff},ExclusiveStartKey:cursor,Limit:100}));
  for(const item of page.Items??[]){
   const refs=await db.send(new QueryCommand({TableName:table,KeyConditionExpression:'pk=:pk AND begins_with(sk,:ref)',ExpressionAttributeValues:{':pk':item.pk,':ref':'REF#'},ConsistentRead:true,Limit:1,ProjectionExpression:'pk'}));checked++;
   if(!refs.Items?.length){await db.send(new DeleteCommand({TableName:table,Key:{pk:item.pk,sk:'META'}}));removed++;}
  }
  cursor=page.LastEvaluatedKey;
 }while(cursor&&Date.now()<deadline);
 await db.send(new UpdateCommand({TableName:table,Key:key,UpdateExpression:cursor?'SET #c=:c':'REMOVE #c',ExpressionAttributeNames:{'#c':'cursor'},...(cursor?{ExpressionAttributeValues:{':c':cursor}}:{})}));
 return {checked,removed,more:Boolean(cursor)};
}

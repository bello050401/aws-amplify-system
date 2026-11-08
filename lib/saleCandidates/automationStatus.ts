import 'server-only';
import {randomUUID} from 'node:crypto';
import {BatchGetCommand,GetCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb as db} from '../inventory/categoryPersistence';
import {candidateConfig} from './store';
export async function automationStatus(ids:string[]){
 const table=candidateConfig().tableName;
 const [config,status,jobs]=await Promise.all([
  db.send(new GetCommand({TableName:table,Key:{id:'AUTOMATION_CONFIG'}})),db.send(new GetCommand({TableName:table,Key:{id:'AUTOMATION_STATUS'}})),
  ids.length?db.send(new BatchGetCommand({RequestItems:{[table]:{Keys:ids.slice(0,80).map(id=>({id:'AUTO:'+id})),ProjectionExpression:'candidateId,#s,phase,reason,updatedAt,completedAt,elapsedMs',ExpressionAttributeNames:{'#s':'state'},ConsistentRead:true}}})):Promise.resolve({Responses:{[table]:[]}})
 ]);
 return {enabled:config.Item?.enabled===true,lastRunAt:status.Item?.lastRunAt??null,jobs:Object.fromEntries((jobs.Responses?.[table]??[]).map(j=>[j.candidateId,j]))};
}
export async function retryAutomaticSale(id:string){
 const now=new Date().toISOString();
 // The worker re-reads source data and uncertain EC receipts; retry never clears a completed sale.
 await db.send(new UpdateCommand({TableName:candidateConfig().tableName,Key:{id:'AUTO:'+id},UpdateExpression:'SET #s=:active,nextAt=:zero,retryRequested=:yes,updatedAt=:now,#v=:v',ConditionExpression:'#s=:attention',ExpressionAttributeNames:{'#s':'state','#v':'version'},ExpressionAttributeValues:{':active':'SALE_AUTO_ACTIVE',':attention':'SALE_AUTO_ATTENTION',':zero':0,':yes':true,':now':now,':v':randomUUID()}}));
}

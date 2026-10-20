import {randomUUID} from 'node:crypto';
import {DynamoDBDocumentClient,GetCommand,PutCommand,ScanCommand,UpdateCommand,DeleteCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import type {Row} from './mapping';
export const CONTROL_ID='transition#control';
export const ITEM_PREFIX='transition#item#';
export const LEASE_ID='transition#lease';
export const PHASES=['DISABLED','BASELINING','ACTIVE','FINALIZING','STOPPED'] as const;
export interface Control extends Row{
  id:string; phase:typeof PHASES[number]; companyId:number; pollMinutes:number;
  initialRunId:string; initialCompletedAt?:string; lastSuccessfulPullAt?:string;
  lastFullReconciliationAt?:string; nextRunAt?:number;
}
export function transitionStore(db:DynamoDBDocumentClient,table:string){
  async function get(id:string):Promise<Row|undefined>{
    return (await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item;
  }
  async function put(row:Row,expectedVersion?:string){
    const next={...row,version:randomUUID(),updatedAt:new Date().toISOString()};
    await db.send(new PutCommand({TableName:table,Item:next,
      ConditionExpression:expectedVersion?'#v=:v':'attribute_not_exists(id)',
      ...(expectedVersion?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':expectedVersion}}:{})}));
    return next as Row;
  }
  async function list(){
    const rows:Row[]=[];let cursor;
    do{
      const page:ScanCommandOutput=await db.send(new ScanCommand({TableName:table,FilterExpression:'begins_with(id,:p)',
        ExpressionAttributeValues:{':p':ITEM_PREFIX},ExclusiveStartKey:cursor,ConsistentRead:true}));
      rows.push(...page.Items??[]);cursor=page.LastEvaluatedKey;
    }while(cursor);
    return rows;
  }
  async function acquire(owner:string){
    try{
      await db.send(new UpdateCommand({TableName:table,Key:{id:LEASE_ID},UpdateExpression:'SET #o=:o, expiresAt=:e',
        ConditionExpression:'attribute_not_exists(#o) OR expiresAt < :now',
        ExpressionAttributeNames:{'#o':'owner'},ExpressionAttributeValues:{':o':owner,':e':Date.now()+260_000,':now':Date.now()}}));
      return true;
    }catch(e){if((e as Error).name==='ConditionalCheckFailedException')return false;throw e;}
  }
  async function assertLease(owner:string){
    const lease=await get(LEASE_ID);
    if(lease?.owner!==owner||lease.expiresAt<Date.now()+25_000)throw Error('同期の実行権を確認できないため停止しました。');
  }
  async function release(owner:string){
    await db.send(new DeleteCommand({TableName:table,Key:{id:LEASE_ID},ConditionExpression:'#o=:o',
      ExpressionAttributeNames:{'#o':'owner'},ExpressionAttributeValues:{':o':owner}}));
  }
  return {get,put,list,acquire,assertLease,release};
}

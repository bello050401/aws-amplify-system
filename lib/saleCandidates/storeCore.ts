import {GetCommand,PutCommand,QueryCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {InventoryTransaction} from '../inventory/categoryPersistenceCore';
import type {SoldOutResult} from '../inventory/soldOutInput';
import {DEFAULT_FEES,type SaleCandidate,type FeeConfig,validateFeeConfig} from './model';
export function createCandidateStore(db:DynamoDBDocumentClient,table:string){
 const get=async(id:string)=>(await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item;
 return {
  get:async(id:string)=>(await get(id)) as SaleCandidate|undefined,
  put:async(value:SaleCandidate)=>{try{await db.send(new PutCommand({TableName:table,Item:value,ConditionExpression:'attribute_not_exists(id)'}));return true;}catch(e){if((e as Error).name==='ConditionalCheckFailedException')return false;throw e;}},
  list:async(state:SaleCandidate['state'],cursor?:string)=>{
   let key;try{key=cursor?JSON.parse(Buffer.from(cursor,'base64url').toString()):undefined;}catch{throw Error('INVALID_CURSOR');}
   if(key&&(typeof key.id!=='string'||key.state!==state||typeof key.receivedAt!=='string'))throw Error('INVALID_CURSOR');
   const r=await db.send(new QueryCommand({TableName:table,IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':state},ScanIndexForward:false,Limit:30,ExclusiveStartKey:key}));
   return {items:(r.Items||[]) as SaleCandidate[],cursor:r.LastEvaluatedKey?Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString('base64url'):null};
  },
  remove:async(id:string,actor:string)=>{await db.send(new UpdateCommand({TableName:table,Key:{id},UpdateExpression:'SET #s=:deleted,deletedBy=:actor,deletedAt=:now,updatedAt=:now',ConditionExpression:'#s=:pending',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':deleted':'DELETED',':pending':'PENDING',':actor':actor,':now':new Date().toISOString()}}));},
  commit:(candidate:SaleCandidate,actor:string,result:SoldOutResult,now:string):InventoryTransaction=>[{Update:{TableName:table,Key:{id:candidate.id},UpdateExpression:'SET #s=:done, #r=:result,completedBy=:actor,completedAt=:now,updatedAt=:now',ConditionExpression:'#s=:pending AND updatedAt=:version',ExpressionAttributeNames:{'#s':'state','#r':'result'},ExpressionAttributeValues:{':pending':'PENDING',':done':'DONE',':result':result,':actor':actor,':now':now,':version':candidate.updatedAt}}}],
  config:async():Promise<FeeConfig>=>{const r=await get('CONFIG');return r?.fees?validateFeeConfig(r.fees):DEFAULT_FEES;},
  configure:async(fees:unknown,actor:string)=>db.send(new PutCommand({TableName:table,Item:{id:'CONFIG',fees:validateFeeConfig(fees),updatedBy:actor,updatedAt:new Date().toISOString()}})),
  status:()=>get('IMPORT_STATUS'),
  baseStatus:()=>get('BASE_IMPORT_STATUS'),
 };
}

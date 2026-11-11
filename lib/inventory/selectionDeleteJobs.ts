import {createHash} from 'node:crypto';
import {GetCommand,PutCommand,QueryCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence} from './categoryPersistenceCore';
export type DeleteTarget={id:string;updatedAt:string;name:string;sku:string};
export type DeleteResult=DeleteTarget&{state:'PENDING'|'SAVED'|'CONFLICT'|'FAILED';error?:string};
export function validateDeleteTargets(id:string,targets:DeleteTarget[]){
 if(!/^[a-f0-9-]{36}$/i.test(id)||!Array.isArray(targets)||!targets.length||targets.length>1000||new Set(targets.map(t=>t.id)).size!==targets.length||targets.some(t=>!t||typeof t.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(t.id)||typeof t.updatedAt!=='string'||!Number.isFinite(Date.parse(t.updatedAt))||typeof t.name!=='string'||t.name.length>10000||typeof t.sku!=='string'||t.sku.length>128))throw Error('削除対象を確認してください。');
}
/** Per-row deletion and its result commit atomically. A duplicated SQS message
 * can only remove the originally reviewed version once. */
export function createSelectionDeleteJobs(p:{db:DynamoDBDocumentClient;jobsTable:string;table:(model:string)=>string;enqueue:(id:string)=>Promise<void>;authorize:(owner:string)=>Promise<boolean>}){
 const key=(id:string,sk='META')=>({pk:'DELETE#'+id,sk}),TableName=p.jobsTable,db=p.db;
 const persistence=createInventoryPersistence(db,p.table);
 async function meta(id:string,owner?:string){const r=(await db.send(new GetCommand({TableName,Key:key(id),ConsistentRead:true}))).Item;if(!r||owner&&r.owner!==owner||Number(r.ttl)<=Date.now()/1000)throw Error('操作記録を取得できません。');return r;}
 async function rows(id:string){const values:DeleteResult[]=[];let cursor:Record<string,unknown>|undefined;do{const r=await db.send(new QueryCommand({TableName,KeyConditionExpression:'pk=:pk AND begins_with(sk,:row)',ExpressionAttributeValues:{':pk':'DELETE#'+id,':row':'ROW#'},ExclusiveStartKey:cursor,ConsistentRead:true}));values.push(...(r.Items??[]).map(i=>i.result as DeleteResult));cursor=r.LastEvaluatedKey;}while(cursor);return values;}
 async function create(id:string,targets:DeleteTarget[],owner:string){
  validateDeleteTargets(id,targets);const hash=createHash('sha256').update(JSON.stringify(targets.map(t=>[t.id,t.updatedAt]))).digest('hex'),ttl=Math.floor(Date.now()/1000)+7*86400;
  try{await db.send(new PutCommand({TableName,Item:{...key(id),owner,hash,total:targets.length,ttl,state:'PREPARING'},ConditionExpression:'attribute_not_exists(pk)'}));}catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;const old=await meta(id,owner);if(old.hash!==hash)throw Error('同じ処理番号で対象を変更できません。');if(old.state!=='PREPARING'){if(old.state==='RUNNING')await p.enqueue(id);return status(id,owner);}}
  for(let offset=0;offset<targets.length;offset+=8)await Promise.all(targets.slice(offset,offset+8).map(async t=>{try{await db.send(new PutCommand({TableName,Item:{...key(id,'ROW#'+t.id),result:{...t,state:'PENDING'},ttl},ConditionExpression:'attribute_not_exists(pk)'}));}catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}}));
  await db.send(new UpdateCommand({TableName,Key:key(id),UpdateExpression:'SET #s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':'RUNNING'}}));await p.enqueue(id);return status(id,owner);
 }
 async function status(id:string,owner:string){const m=await meta(id,owner),items=await rows(id);return {id,state:m.state as string,total:m.total as number,items,done:items.filter(i=>i.state!=='PENDING').length};}
 async function run(id:string,shouldYield=()=>false){
  const m=await meta(id);if(m.state==='PREPARING')throw Error('Deletion has not been submitted');if(m.state==='COMPLETE')return false;
  const allowed=await p.authorize(String(m.owner));
  for(const item of await rows(id)){
   if(item.state!=='PENDING')continue;if(shouldYield())return true;
   try{
    if(!allowed)throw Error('削除権限が解除されたため中止しました。');
    const r={...item,state:'SAVED'};
    await persistence.deleteInventoryWithCategories(item.id,item.updatedAt,String(m.owner),[{Update:{TableName,Key:key(id,'ROW#'+item.id),UpdateExpression:'SET #r=:r',ConditionExpression:'#r.#s=:pending',ExpressionAttributeNames:{'#r':'result','#s':'state'},ExpressionAttributeValues:{':r':r,':pending':'PENDING'}}}]);
   }catch(e){
    const current=(await db.send(new GetCommand({TableName,Key:key(id,'ROW#'+item.id),ConsistentRead:true}))).Item;if(current?.result?.state==='SAVED')continue;
    const inventory=await persistence.getInventoryRaw(item.id);
    const conflict=!inventory||inventory.updatedAt!==item.updatedAt;
    const result={...item,state:conflict?'CONFLICT':'FAILED',error:!allowed?'削除権限が解除されています。':conflict?'他の操作で更新・削除されました。対象を確認し直してください。':'削除できませんでした。出庫・到着確認待ち、または通信状態を確認してください。'};
    try{await db.send(new UpdateCommand({TableName,Key:key(id,'ROW#'+item.id),UpdateExpression:'SET #r=:r',ConditionExpression:'#r.#s=:pending',ExpressionAttributeNames:{'#r':'result','#s':'state'},ExpressionAttributeValues:{':r':result,':pending':'PENDING'}}));}catch(error){if((error as Error).name!=='ConditionalCheckFailedException')throw error;}
   }
  }
  await db.send(new UpdateCommand({TableName,Key:key(id),UpdateExpression:'SET #s=:done',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':done':'COMPLETE'}}));return false;
 }
 async function resume(id:string,owner:string){const m=await meta(id,owner);if(m.state==='RUNNING')await p.enqueue(id);return status(id,owner);}
 return {create,status,run,resume};
}

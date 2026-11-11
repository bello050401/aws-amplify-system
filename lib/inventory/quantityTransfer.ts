import {createHash} from 'node:crypto';
import {GetCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {sendInventoryTransaction} from './historyTransaction';
import {managedStockTitleChange} from './managedStockTitle';
import {withHumanEdits} from './humanEdits';
import {parseCustomFields} from './customFieldsCodecCore';
import {inventoryQuantityError} from './quantityValidation';
import type {InventoryTransaction} from './categoryPersistenceCore';
export type TransferRequest={operationId:string;sourceId:string;targetId:string;sourceVersion:string;targetVersion:string;quantity:number};
type Row=Record<string,unknown>;
export function transferQuantities(source:number,target:number,quantity:number){
 if(inventoryQuantityError(source)||inventoryQuantityError(target)||!Number.isSafeInteger(quantity)||quantity<1||quantity>source)throw Error('移動数量を確認してください。');
 const after={source:source-quantity,target:target+quantity};if(inventoryQuantityError(after.target))throw Error('移動先の数量が上限を超えます。');return after;
}
export function createQuantityTransfer(p:{db:DynamoDBDocumentClient;table:(name:string)=>string}){
 return async(r:TransferRequest,actor:string)=>{
  if(!r||![r.operationId,r.sourceId,r.targetId].every(v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v))||r.sourceId===r.targetId||![r.sourceVersion,r.targetVersion].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))throw Error('移動元・移動先を選び直してください。');
  const identity=createHash('sha256').update(JSON.stringify([actor,r.sourceId,r.targetId,r.sourceVersion,r.targetVersion,r.quantity])).digest('hex'),receiptId='QUANTITY_TRANSFER:'+r.operationId;
  const receipt=async()=>{const item=(await p.db.send(new GetCommand({TableName:p.table('InventoryHistory'),Key:{id:receiptId},ConsistentRead:true}))).Item;if(!item)return null;const v=JSON.parse(item.newValue);if(v.hash!==identity)throw Error('同じ処理番号で移動内容を変更できません。');return v.result as {source:number;target:number};};
  const existing=await receipt();if(existing)return existing;
  const [source,target]=await Promise.all([r.sourceId,r.targetId].map(async id=>(await p.db.send(new GetCommand({TableName:p.table('Inventory'),Key:{id},ConsistentRead:true}))).Item));
  if(!source||!target||source.updatedAt!==r.sourceVersion||target.updatedAt!==r.targetVersion)throw Error('商品が更新されています。移動元・移動先を確認し直してください。');
  if([source,target].some(row=>row.deletedAt||row.listingPartition==='MERGED'||row.outboundBatchId||row.outboundArrivalBatchId))throw Error('出庫処理中・到着確認待ち・削除済みの商品は数量を移動できません。');
  if((source.unit??'')!==(target.unit??''))throw Error('数量の単位が異なります。商品を確認してください。');
  if(typeof source.quantity!=='number'||typeof target.quantity!=='number')throw Error('数量が未入力の商品は移動できません。');
  const result=transferQuantities(source.quantity,target.quantity,r.quantity),now=new Date(Math.max(Date.now(),Date.parse(r.sourceVersion)+1,Date.parse(r.targetVersion)+1)).toISOString();
  const update=(row:Row,quantity:number)=>{const custom=parseCustomFields(row.customFields),patch=managedStockTitleChange({quantity,updatedAt:now,listUpdatedAt:now,updatedBy:actor,customFields:JSON.stringify(withHumanEdits(row,{quantity},custom,custom??undefined))},row),entries=Object.entries(patch);return {Update:{TableName:p.table('Inventory'),Key:{id:row.id},UpdateExpression:'SET '+entries.map((_,i)=>`#f${i}=:v${i}`).join(', '),ExpressionAttributeNames:Object.fromEntries(entries.map(([k],i)=>['#f'+i,k])),ExpressionAttributeValues:{...Object.fromEntries(entries.map(([,v],i)=>[':v'+i,v])),':version':row.updatedAt,':quantity':row.quantity},ConditionExpression:'updatedAt=:version AND quantity=:quantity AND attribute_not_exists(deletedAt) AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(outboundArrivalBatchId)'}};};
  const writes:InventoryTransaction=[update(source,result.source),update(target,result.target),...([source,target].map((row,i)=>({Put:{TableName:p.table('InventoryHistory'),Item:{id:receiptId+(i?':TARGET':''),inventoryId:row.id,fieldName:'数量移動',oldValue:JSON.stringify({quantity:row.quantity}),newValue:JSON.stringify({quantity:i?result.target:result.source,movedQuantity:r.quantity,...(!i?{hash:identity,result}:{})}),changedBy:actor,changedAt:now,createdAt:now,updatedAt:now,__typename:'InventoryHistory'},ConditionExpression:'attribute_not_exists(id)'}})))];
  try{await sendInventoryTransaction(p.db,{TransactItems:writes},{source:'既存在庫への数量移動',actor,operationId:r.operationId,before:new Map([[r.sourceId,source],[r.targetId,target]]),blockedReason:'2商品の数量を同時に移動しています。数量を戻す場合は、移動先から移動元への数量移動を行ってください。'});}catch(e){const saved=await receipt();if(saved)return saved;throw Error((e as Error).name==='TransactionCanceledException'?'別の更新と重なりました。数量は移動していません。':'保存結果を確認できません。同じ内容で再確認してください。');}
  return result;
 };
}

'use server';
import {createHash} from 'node:crypto';
import {GetCommand} from '@aws-sdk/lib-dynamodb';
import {revalidatePath} from 'next/cache';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb,inventoryTable,persistInventoryWithCategories} from '@/lib/inventory/categoryPersistence';
import {readInventoryBatch} from '@/lib/inventory/batchRead';
import {inventoryEditConfig} from '@/lib/inventory/editJobs';
import {boundedMap} from '@/lib/inventory/editJobsCore';
import {sameValue} from '@/lib/inventory/reversibleHistory';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {validateInlineChanges, type InlineEditChanges} from '@/lib/inventory/inlineEdit';
import {withHumanEdits} from '@/lib/inventory/humanEdits';
import {parseCustomFields} from '@/lib/inventory/customFieldsCodecCore';
import {listAllCustomFieldDefinitions} from '@/lib/inventory/queries';
export interface BulkInventoryEditItem {id:string;expectedUpdatedAt:string;expectedRevision?:number;changes:InlineEditChanges}
export interface BulkInventoryEditItemResult {id:string;success:boolean;error?:string;changed?:boolean;updatedAt?:string;changes?:InlineEditChanges}
/** One batch read, bounded independent transactions, per-item receipts committed
 * atomically with the product. Same request ID can safely resume for seven days. */
export async function bulkUpdateInventoryListFields(items:BulkInventoryEditItem[],operationId:string):Promise<BulkInventoryEditItemResult[]>{
 const access=await inventoryMutationSession();if(!access)throw Error('在庫を編集する権限がありません。');
 if(!/^[a-f0-9-]{36}$/i.test(operationId)||!Array.isArray(items)||items.length>200||new Set(items.map(i=>i.id)).size!==items.length)throw Error('保存対象を確認してください。');
 if(!items.length)return [];
 const definitions=items.some(item=>item.changes?.customFieldChanges)?await listAllCustomFieldDefinitions():[];
 const current=await readInventoryBatch(inventoryDdb,inventoryTable('Inventory'),items.map(i=>i.id)),table=inventoryEditConfig().table;
 const result=await boundedMap(items,8,async item=>{
  const key={pk:'DIRECT#'+operationId,sk:'ROW#'+item.id};
  const hash=createHash('sha256').update(JSON.stringify([access.owner,item])).digest('hex');
  const receipt=async()=>{const row=(await inventoryDdb.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}))).Item;if(!row)return null;if(row.owner!==access.owner||row.hash!==hash)throw Error('同じ操作IDで内容を変更できません。');return row.result as BulkInventoryEditItemResult;};
  try{
   const prior=await receipt();if(prior)return prior;
   validateInlineChanges(item.changes,definitions);
   const before=current.get(item.id);if(!before||before.deletedAt)throw Error('対象の在庫が見つかりません。');
   if(item.expectedUpdatedAt!==before.updatedAt||(item.expectedRevision!==undefined&&item.expectedRevision!==Number(before.revision??0)))throw Error('他の操作で更新されています。最新状態を確認してください。');
   if(item.changes.locationId){const location=(await inventoryDdb.send(new GetCommand({TableName:inventoryTable('Location'),Key:{id:item.changes.locationId},ConsistentRead:true}))).Item;if(!location||location.isActive===false)throw Error('保管場所を確認してください。');}
   const beforeCustom=parseCustomFields(before.customFields)??{};
   const {customFieldChanges,...scalarChanges}=item.changes;
   const customPatch=Object.fromEntries(Object.entries(customFieldChanges??{}).filter(([k,v])=>!sameValue(v??null,beforeCustom[k]??null)));
   const changes={...Object.fromEntries(Object.entries(scalarChanges).filter(([k,v])=>!sameValue(v??undefined,k==='categoryIds'?inventoryCategoryIds(before):before[k]??undefined))),...(Object.keys(customPatch).length?{customFieldChanges:customPatch}:{})} as InlineEditChanges;
   if(!Object.keys(changes).length)return {id:item.id,success:true,changed:false,updatedAt:String(before.updatedAt),changes};
   const {customFieldChanges:customChanges,...savedChanges}=changes;
   const custom={...beforeCustom,...customChanges},response:BulkInventoryEditItemResult={id:item.id,success:true,changed:true,changes};
   const saved=await persistInventoryWithCategories({id:item.id,...savedChanges,updatedBy:access.owner,listUpdatedAt:new Date().toISOString(),customFields:JSON.stringify(withHumanEdits(before,{...savedChanges},beforeCustom,custom))},item.expectedUpdatedAt,{current:before,history:{source:'一覧直接編集',actor:access.owner,operationId},extraWrites:[{Put:{TableName:table,Item:{...key,owner:access.owner,hash,result:response,ttl:Math.floor(Date.now()/1000)+7*86400},ConditionExpression:'attribute_not_exists(pk)'}}]});
   return {...response,updatedAt:saved.updatedAt};
  }catch(error){try{const committed=await receipt();if(committed)return committed;}catch{/* The original error describes a reused ID or an unreadable result. */}return {id:item.id,success:false,error:error instanceof Error?error.message:'保存結果を確認できません。入力内容は保持されています。'};}
 });
 if(result.some(r=>r.success&&r.changed)){clearInventoryCountCache();revalidatePath('/inventory');}
 return result;
}

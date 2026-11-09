import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { inventoryCategoryIds } from './categories';
import { InventorySaveError, InventoryMutationRejected } from './conditionalUpdate';
import {managedStockTitleChange} from './managedStockTitle';
import {sendInventoryTransaction, type HistoryWriteContext} from './historyTransaction';
import {sameValue, inventoryDiff, readEditHistory, EMPTY_EDIT_HISTORY} from './reversibleHistory';
import {historyReferenceTable,historyReferenceChanges} from './historyReferences';
import {validateName, validateCategoryArray} from './editTransform';

export type InventoryTransaction = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

/** Server/worker adapter: callers authenticate and supply their exact table namespace. */
export function createInventoryPersistence(inventoryDdb: DynamoDBDocumentClient, inventoryTable: (model: string) => string) {
function categoryLinkId(inventoryId:string,categoryId:string) { return `${inventoryId}:${categoryId}`; }
function categoryLinkChanges(id:string,before:string[],after:string[],now:string):InventoryTransaction {
  return [
    ...before.filter(cat=>!after.includes(cat)).map(cat=>({Delete:{TableName:inventoryTable('InventoryCategory'),Key:{id:categoryLinkId(id,cat)}}})),
    ...after.filter(cat=>!before.includes(cat)).map(cat=>({Put:{TableName:inventoryTable('InventoryCategory'),Item:{id:categoryLinkId(id,cat),inventoryId:id,categoryId:cat,__typename:'InventoryCategory',createdAt:now,updatedAt:now}}})),
  ];
}
async function getInventoryRaw(id:string) {
  return (await inventoryDdb.send(new GetCommand({TableName:inventoryTable('Inventory'),Key:{id},ConsistentRead:true}))).Item;
}
async function validateCategoryIds(ids:string[]) {
  validateCategoryArray(ids);
  if(!ids.length)return;
  const table=inventoryTable('Category'),found=new Set<string>();
  let keys=[...new Set(ids)].map(id=>({id}));
  for(let attempt=0;keys.length&&attempt<5;attempt++){
    if(attempt)await new Promise(resolve=>setTimeout(resolve,25*2**attempt));
    const response=await inventoryDdb.send(new BatchGetCommand({RequestItems:{[table]:{Keys:keys,ConsistentRead:true,ProjectionExpression:'id,isActive'}}}));
    for(const row of response.Responses?.[table]??[])if(row.isActive!==false)found.add(String(row.id));
    keys=(response.UnprocessedKeys?.[table]?.Keys??[]) as {id:string}[];
  }
  if(keys.length)throw new InventorySaveError('UNCONFIRMED');
  if(ids.some(id=>!found.has(id))) throw new InventoryMutationRejected('CATEGORY_INVALID');
}
/** A barcode identifies a product, not a stock page. Sold and remaining stock
 * may share it. Inventory.id continues to identify each independent page. */
function validateBarcode(value:unknown) {
  if(value == null) return;
  if(typeof value !== 'string' || value.trim().length>256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new InventoryMutationRejected('BARCODE_INVALID');
}
async function persistInventoryWithCategories(input:Record<string,unknown>,expectedUpdatedAt?:string,_legacyOptions?:{preserveZaicoSourceBarcode?:boolean;current?:Record<string,unknown>;validatedCategories?:readonly string[];history?:HistoryWriteContext;extraWrites?:InventoryTransaction}):Promise<{id:string;updatedAt:string;changed?:boolean;revision?:number}> {
  if(Object.hasOwn(input,'revision')||Object.hasOwn(input,'editHistory'))throw new Error('変更履歴は直接書き換えできません。');
  const id=String(input.id || randomUUID());
  const current=expectedUpdatedAt?(_legacyOptions?.current??await getInventoryRaw(id)):undefined;
  if(expectedUpdatedAt && (!current || current.updatedAt!==expectedUpdatedAt)) throw new InventorySaveError('CONFLICT');
  if(current?.listingPartition==='MERGED') throw new InventoryMutationRejected('MERGED');
  if(current?.outboundBatchId) throw new InventoryMutationRejected('OUTBOUND_RESERVED');
  input=managedStockTitleChange(input,current);
  if(input.name!==undefined)validateName(input.name);
  // Legacy adapter option remains compatible; every caller now allows shared codes.
  void _legacyOptions;
  validateBarcode(input.barcode);
  const before=inventoryCategoryIds(current ?? {});
  const after=Array.isArray(input.categoryIds)?[...new Set(input.categoryIds as string[])]:input.categoryId===undefined?before:
    [...new Set([...(input.categoryId?[String(input.categoryId)]:[]),...before.filter(cat=>cat!==current?.categoryId)])];
  if(current?.outboundArrivalBatchId && (
    input.quantity!==undefined && input.quantity!==current.quantity ||
    input.locationId!==undefined && input.locationId!==current.locationId ||
    before.length!==after.length || before.some(id=>!after.includes(id))
  )) throw new InventoryMutationRejected('ARRIVAL_RESERVED');
  validateCategoryArray(after);
  // Unrelated edits may retain a retired category already present on the item.
  // Newly assigned categories must still be active at commit time.
  const assigned=after.filter(id=>!before.includes(id));
  if(!_legacyOptions?.validatedCategories||assigned.some(id=>!_legacyOptions.validatedCategories!.includes(id)))await validateCategoryIds(assigned);
  const substantive=Object.fromEntries(Object.entries(input).filter(([key,value])=>value!==undefined&&!['id','updatedAt','listUpdatedAt','updatedBy'].includes(key)));
  if(current&&Object.entries(substantive).every(([key,value])=>sameValue(value===null?undefined:value,current[key]))&&sameValue(before,after)&&!_legacyOptions?.extraWrites?.length)
    return {id,updatedAt:String(current.updatedAt),changed:false,revision:Number(current.revision??0)};
  const now=new Date(Math.max(Date.now(), Date.parse(String(current?.updatedAt??''))+1 || 0)).toISOString();
  const values={...input,id,categoryId:after[0]??null,categoryIds:after,updatedAt:now,...(typeof input.barcode==='string'?{barcode:input.barcode.trim()}: {})};
  const changes=categoryLinkChanges(id,before,after,now);
  changes.push(...assigned.map(categoryId=>({ConditionCheck:{TableName:inventoryTable('Category'),Key:{id:categoryId},ConditionExpression:'attribute_exists(id) AND (attribute_not_exists(isActive) OR isActive=:active)',ExpressionAttributeValues:{':active':true}}})));
  if(expectedUpdatedAt) {
    const entries=Object.entries(values).filter(([key,value])=>key!=='id' && value!==undefined);
    const names=Object.fromEntries(entries.map(([key],i)=>[`#f${i}`,key]));
    const attributes=Object.fromEntries(entries.flatMap(([,value],i)=>value===null?[]:[[`:v${i}`,value]]));
    const sets=entries.flatMap(([,value],i)=>value===null?[]:[`#f${i} = :v${i}`]),removes=entries.flatMap(([,value],i)=>value===null?[`#f${i}`]:[]);
    changes.unshift({Update:{TableName:inventoryTable('Inventory'),Key:{id},UpdateExpression:'SET '+sets.join(', ')+(removes.length?' REMOVE '+removes.join(', '):''),
      ConditionExpression:'updatedAt = :version AND attribute_not_exists(outboundBatchId)',ExpressionAttributeNames:names,ExpressionAttributeValues:{...attributes,':version':expectedUpdatedAt}}});
  } else changes.unshift({Put:{TableName:inventoryTable('Inventory'),Item:{...Object.fromEntries(Object.entries(values).filter(([,v])=>v!==null)),createdAt:now,__typename:'Inventory'},ConditionExpression:'attribute_not_exists(id)'}});
  if(_legacyOptions?.extraWrites)changes.push(..._legacyOptions.extraWrites);
  try { await sendInventoryTransaction(inventoryDdb,{TransactItems:changes},{source:_legacyOptions?.preserveZaicoSourceBarcode?'ZAICO同期':'在庫編集',..._legacyOptions?.history,before:current?new Map([[id,current]]):undefined}); }
  catch(error) {
    if(error instanceof Error && error.name==='TransactionCanceledException') {
      throw new InventorySaveError('CONFLICT');
    }
    throw new InventorySaveError('UNCONFIRMED');
  }
  return {id,updatedAt:now,changed:true,revision:Number(current?.revision??0)+(current&&inventoryDiff({...current,categoryIds:before},{...current,...values}).length?1:0)};
}

/** Delete the inventory and its owned category links in the same conditional transaction. */
async function deleteInventoryWithCategories(id:string,expectedUpdatedAt:string,changedBy='在庫削除') {
  const row=await getInventoryRaw(id);
  if(!row || row.updatedAt!==expectedUpdatedAt) throw new InventorySaveError('CONFLICT');
  if(row.listingPartition==='MERGED') throw new InventoryMutationRejected('MERGED');
  if(row.outboundBatchId) throw new InventoryMutationRejected('OUTBOUND_RESERVED');
  if(row.outboundArrivalBatchId) throw new InventoryMutationRejected('ARRIVAL_RESERVED');
  const changes:InventoryTransaction=[{Delete:{TableName:inventoryTable('Inventory'),Key:{id},ConditionExpression:'updatedAt = :version AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(outboundArrivalBatchId)',ExpressionAttributeValues:{':version':expectedUpdatedAt}}},...categoryLinkChanges(id,inventoryCategoryIds(row),[],new Date().toISOString())];
  const refs=historyReferenceTable(inventoryTable('Inventory'));
  if(refs)changes.push(...historyReferenceChanges(refs,id,readEditHistory(row),EMPTY_EDIT_HISTORY));
  // Keep proof of deletion in the same transaction. Background photo cleanup
  // must distinguish a deleted product from a missing/misconfigured table.
  const deletedAt=new Date().toISOString();
  changes.push({Put:{TableName:inventoryTable('InventoryHistory'),Item:{id:randomUUID(),inventoryId:id,changedAt:deletedAt,changedBy,fieldName:'削除',oldValue:'有効',newValue:'削除済み',createdAt:deletedAt,updatedAt:deletedAt,__typename:'InventoryHistory'},ConditionExpression:'attribute_not_exists(id)'}});
  try {await inventoryDdb.send(new TransactWriteCommand({TransactItems:changes}));}
  catch(error) {throw new InventorySaveError(error instanceof Error && error.name==='TransactionCanceledException'?'CONFLICT':'UNCONFIRMED');}
}

return { categoryLinkId, categoryLinkChanges, getInventoryRaw, validateCategoryIds, persistInventoryWithCategories, deleteInventoryWithCategories };
}

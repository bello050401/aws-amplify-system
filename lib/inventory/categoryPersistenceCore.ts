import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { inventoryCategoryIds } from './categories';
import { InventorySaveError, InventoryMutationRejected } from './conditionalUpdate';

export type InventoryTransaction = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

/** Server/worker adapter: callers authenticate and supply their exact table namespace. */
export function createInventoryPersistence(inventoryDdb: DynamoDBDocumentClient, inventoryTable: (model: string) => string) {
function categoryLinkId(inventoryId:string,categoryId:string) { return `${inventoryId}:${categoryId}`; }
function categoryLinkChanges(id:string,before:string[],after:string[],now:string):InventoryTransaction {
  return [
    ...before.filter(cat=>!after.includes(cat)).map(cat=>({Delete:{TableName:inventoryTable('InventoryCategory'),Key:{id:categoryLinkId(id,cat)}}})),
    ...after.map(cat=>({Put:{TableName:inventoryTable('InventoryCategory'),Item:{id:categoryLinkId(id,cat),inventoryId:id,categoryId:cat,__typename:'InventoryCategory',createdAt:now,updatedAt:now}}})),
  ];
}
async function getInventoryRaw(id:string) {
  return (await inventoryDdb.send(new GetCommand({TableName:inventoryTable('Inventory'),Key:{id},ConsistentRead:true}))).Item;
}
async function validateCategoryIds(ids:string[]) {
  if (ids.length>20 || ids.some(id=>typeof id!=='string' || !id || id.length>128)) throw new InventoryMutationRejected('CATEGORY_INVALID');
  const entries=await Promise.all(ids.map(id=>inventoryDdb.send(new GetCommand({TableName:inventoryTable('Category'),Key:{id},ConsistentRead:true}))));
  if(entries.some(x=>!x.Item)) throw new InventoryMutationRejected('CATEGORY_INVALID');
}
/** A barcode identifies a product, not a stock page. Sold and remaining stock
 * may share it. Inventory.id continues to identify each independent page. */
function validateBarcode(value:unknown) {
  if(value == null) return;
  if(typeof value !== 'string' || value.trim().length>256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new InventoryMutationRejected('BARCODE_INVALID');
}
async function persistInventoryWithCategories(input:Record<string,unknown>,expectedUpdatedAt?:string,_legacyOptions?:{preserveZaicoSourceBarcode?:boolean}):Promise<{id:string;updatedAt:string}> {
  const id=String(input.id || randomUUID());
  const current=expectedUpdatedAt?await getInventoryRaw(id):undefined;
  if(expectedUpdatedAt && (!current || current.updatedAt!==expectedUpdatedAt)) throw new InventorySaveError('CONFLICT');
  if(current?.listingPartition==='MERGED') throw new InventoryMutationRejected('MERGED');
  if(current?.outboundBatchId) throw new InventoryMutationRejected('OUTBOUND_RESERVED');
  // Legacy adapter option remains compatible; every caller now allows shared codes.
  void _legacyOptions;
  validateBarcode(input.barcode);
  const before=inventoryCategoryIds(current ?? {});
  const after=Array.isArray(input.categoryIds)?[...new Set(input.categoryIds as string[])]:input.categoryId===undefined?before:
    [...new Set([...(input.categoryId?[String(input.categoryId)]:[]),...before.filter(cat=>cat!==current?.categoryId)])];
  await validateCategoryIds(after);
  const now=new Date(Math.max(Date.now(), Date.parse(String(current?.updatedAt??''))+1 || 0)).toISOString();
  const values={...input,id,categoryId:after[0]??null,categoryIds:after,updatedAt:now,...(typeof input.barcode==='string'?{barcode:input.barcode.trim()}: {})};
  const changes=categoryLinkChanges(id,before,after,now);
  if(expectedUpdatedAt) {
    const entries=Object.entries(values).filter(([key,value])=>key!=='id' && value!==undefined);
    const names=Object.fromEntries(entries.map(([key],i)=>[`#f${i}`,key]));
    const attributes=Object.fromEntries(entries.flatMap(([,value],i)=>value===null?[]:[[`:v${i}`,value]]));
    const sets=entries.flatMap(([,value],i)=>value===null?[]:[`#f${i} = :v${i}`]),removes=entries.flatMap(([,value],i)=>value===null?[`#f${i}`]:[]);
    changes.unshift({Update:{TableName:inventoryTable('Inventory'),Key:{id},UpdateExpression:'SET '+sets.join(', ')+(removes.length?' REMOVE '+removes.join(', '):''),
      ConditionExpression:'updatedAt = :version AND attribute_not_exists(outboundBatchId)',ExpressionAttributeNames:names,ExpressionAttributeValues:{...attributes,':version':expectedUpdatedAt}}});
  } else changes.unshift({Put:{TableName:inventoryTable('Inventory'),Item:{...Object.fromEntries(Object.entries(values).filter(([,v])=>v!==null)),createdAt:now,__typename:'Inventory'},ConditionExpression:'attribute_not_exists(id)'}});
  try { await inventoryDdb.send(new TransactWriteCommand({TransactItems:changes})); }
  catch(error) {
    if(error instanceof Error && error.name==='TransactionCanceledException') {
      throw new InventorySaveError('CONFLICT');
    }
    throw new InventorySaveError('UNCONFIRMED');
  }
  return {id,updatedAt:now};
}

/** Delete the inventory and its owned category links in the same conditional transaction. */
async function deleteInventoryWithCategories(id:string,expectedUpdatedAt:string,changedBy='在庫削除') {
  const row=await getInventoryRaw(id);
  if(!row || row.updatedAt!==expectedUpdatedAt) throw new InventorySaveError('CONFLICT');
  if(row.listingPartition==='MERGED') throw new InventoryMutationRejected('MERGED');
  if(row.outboundBatchId) throw new InventoryMutationRejected('OUTBOUND_RESERVED');
  const changes:InventoryTransaction=[{Delete:{TableName:inventoryTable('Inventory'),Key:{id},ConditionExpression:'updatedAt = :version AND attribute_not_exists(outboundBatchId)',ExpressionAttributeValues:{':version':expectedUpdatedAt}}},...categoryLinkChanges(id,inventoryCategoryIds(row),[],new Date().toISOString())];
  // Keep proof of deletion in the same transaction. Background photo cleanup
  // must distinguish a deleted product from a missing/misconfigured table.
  const deletedAt=new Date().toISOString();
  changes.push({Put:{TableName:inventoryTable('InventoryHistory'),Item:{id:randomUUID(),inventoryId:id,changedAt:deletedAt,changedBy,fieldName:'削除',oldValue:'有効',newValue:'削除済み',createdAt:deletedAt,updatedAt:deletedAt,__typename:'InventoryHistory'},ConditionExpression:'attribute_not_exists(id)'}});
  try {await inventoryDdb.send(new TransactWriteCommand({TransactItems:changes}));}
  catch(error) {throw new InventorySaveError(error instanceof Error && error.name==='TransactionCanceledException'?'CONFLICT':'UNCONFIRMED');}
}

return { categoryLinkId, categoryLinkChanges, getInventoryRaw, validateCategoryIds, persistInventoryWithCategories, deleteInventoryWithCategories };
}

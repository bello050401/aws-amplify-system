import {createHash,randomUUID} from 'node:crypto';
import {GetCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence,type InventoryTransaction} from './categoryPersistenceCore';
import {inventoryCategoryIds} from './categories';
import {ALL_EXTENDED_FIELDS} from './extendedFields';
import {withHumanEdits,productCustomFields} from './humanEdits';
import {parseCustomFields,stringifyCustomFields} from './customFieldsCodec';
import {StockSplitError,validateStockSplit,type StockSplitRequest,type StockSplitResult} from './stockSplitInput';
type Row=Record<string,unknown>;
export interface StockSplitPorts {db:DynamoDBDocumentClient;table:(name:string)=>string;nextSku:()=>Promise<string>;copyPhotos:(source:Row,attemptId:string)=>Promise<unknown[]>;discardPhotos:(images:unknown[])=>Promise<void>;now?:()=>string}
/** Inventory, category links and retry receipt are committed as one transaction. */
export function createStockSplitService(p:StockSplitPorts) {
 const persistence=createInventoryPersistence(p.db,p.table);
 return async(r:StockSplitRequest,actor:string):Promise<StockSplitResult>=>{
  validateStockSplit(r,undefined,actor);
  const receiptId='STOCK_SPLIT:'+r.mutationId;
  const identity:unknown[]=[actor,r.inventoryId,r.expectedUpdatedAt,r.quantity,r.damageNotes,r.barcode.trim(),r.photos];
  // Preserve retries from clients opened before the title fields were added.
  if(r.sourceName!==undefined||r.splitName!==undefined)identity.push([r.sourceName?.trim(),r.splitName?.trim()]);
  const hash=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const receipt=async()=>{
   const row=(await p.db.send(new GetCommand({TableName:p.table('InventoryHistory'),Key:{id:receiptId},ConsistentRead:true}))).Item;
   if(!row)return null;const data=JSON.parse(row.newValue);
   if(data.hash!==hash)throw new StockSplitError('CONFLICT','別の内容で使用された処理です。商品を開き直してください。');
   return data.result as StockSplitResult;
  };
  const prior=await receipt();if(prior)return prior;
  const source=await persistence.getInventoryRaw(r.inventoryId);
  if(!source||source.deletedAt||source.updatedAt!==r.expectedUpdatedAt)throw new StockSplitError('CONFLICT','商品が更新されています。開き直してください。');
  if(source.listingPartition==='MERGED'||source.outboundBatchId||source.outboundArrivalBatchId)throw new StockSplitError('INVALID','出庫処理中・到着確認待ち・合算済みの在庫は分けられません。');
  validateStockSplit(r,source.quantity,actor);
  const cats=inventoryCategoryIds(source);await persistence.validateCategoryIds(cats);
  const now=new Date(Math.max(Date.parse(p.now?.()??new Date().toISOString()),Date.parse(String(source.updatedAt))+1)).toISOString(),id=randomUUID();
  const sku=await p.nextSku(),custom=parseCustomFields(source.customFields);
  const parsed=typeof source.images==='string'?JSON.parse(source.images):source.images;
  if(parsed!=null&&!Array.isArray(parsed))throw new StockSplitError('INVALID','元の写真情報を確認できないため、分割を中止しました。');
  const originals:unknown[]=Array.isArray(parsed)?parsed:[];
  // Copy inherited photos independently. New, owner-scoped uploads belong directly
  // to the child: copying them again would leave a second cloud object behind.
  const inheritedPhotos=await p.copyPhotos({...source,images:originals},id);
  const images=[...inheritedPhotos,...r.photos.map((photo,i)=>({...photo,sortOrder:inheritedPhotos.length+i,isPrimary:false}))];
  const result:StockSplitResult={sourceId:String(source.id),splitId:id,remainingQuantity:Number(source.quantity)-r.quantity,splitQuantity:r.quantity,updatedAt:now};
  const remaining={quantity:result.remainingQuantity,...(r.sourceName!==undefined?{name:r.sourceName.trim()}:{}),updatedAt:now,listUpdatedAt:now,updatedBy:actor};
  const values={...remaining,customFields:stringifyCustomFields(withHumanEdits(source,remaining,custom,custom??undefined))},entries=Object.entries(values);
  const inherited:Row={};
  for(const key of ['name','unit','statusId','locationId','note','purchasePrice','salePrice',...ALL_EXTENDED_FIELDS.map(f=>f.key)])if(source[key]!==undefined)inherited[key]=source[key];
  const child={...inherited,...(r.splitName!==undefined?{name:r.splitName.trim()}:{}),id,sku,quantity:r.quantity,barcode:r.barcode.trim(),damageNotes:r.damageNotes,
   ...(cats.length?{categoryId:cats[0]}:{}),categoryIds:cats,images,sourceSystem:'BELLO',listingPartition:'ACTIVE',createdAt:now,updatedAt:now,listUpdatedAt:now,createdBy:actor,updatedBy:actor,
   customFields:stringifyCustomFields({...productCustomFields(custom),__belloStockSplit:{sourceInventoryId:source.id,operation:'STOCK_SPLIT',mutationId:r.mutationId}}),__typename:'Inventory'};
  const writes:InventoryTransaction=[
   {Update:{TableName:p.table('Inventory'),Key:{id:source.id},UpdateExpression:'SET '+entries.map((_,i)=>`#f${i}=:v${i}`).join(', '),ConditionExpression:'updatedAt=:version AND quantity=:quantity AND attribute_not_exists(deletedAt) AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(outboundArrivalBatchId)',ExpressionAttributeNames:Object.fromEntries(entries.map(([key],i)=>[`#f${i}`,key])),ExpressionAttributeValues:{...Object.fromEntries(entries.map(([,value],i)=>[`:v${i}`,value])),':version':source.updatedAt,':quantity':source.quantity}}},
   // Sparse-index keys cannot contain NULL. Match normal inventory creation.
   {Put:{TableName:p.table('Inventory'),Item:Object.fromEntries(Object.entries(child).filter(([,value])=>value!==null&&value!==undefined)),ConditionExpression:'attribute_not_exists(id)'}},
   ...persistence.categoryLinkChanges(id,[],cats,now),
   {Put:{TableName:p.table('InventoryHistory'),Item:{id:receiptId,inventoryId:source.id,fieldName:'在庫分け',oldValue:JSON.stringify({quantity:source.quantity,name:source.name}),newValue:JSON.stringify({hash,result,name:r.sourceName?.trim()??source.name,splitName:child.name}),changedBy:actor,changedAt:now,createdAt:now,updatedAt:now,__typename:'InventoryHistory'},ConditionExpression:'attribute_not_exists(id)'}},
   {Put:{TableName:p.table('InventoryHistory'),Item:{id:receiptId+':SPLIT',inventoryId:id,fieldName:'在庫分け',newValue:JSON.stringify({sourceInventoryId:source.id,quantity:r.quantity,name:child.name}),changedBy:actor,changedAt:now,createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}}
  ];
  try{await p.db.send(new TransactWriteCommand({TransactItems:writes,ClientRequestToken:randomUUID()}));}
  catch(error){
   const committed=await receipt().catch(()=>null);
   if(committed){if(committed.splitId!==id)await p.discardPhotos(inheritedPhotos);return committed;}
   if(error instanceof Error&&error.name==='TransactionCanceledException'){await p.discardPhotos(inheritedPhotos);throw new StockSplitError('CONFLICT','別の更新と重なったため分割していません。商品を開き直してください。');}
   throw new StockSplitError('UNCONFIRMED','保存結果を確認できません。同じ内容で結果を再確認してください。');
  }
  return result;
 };
}

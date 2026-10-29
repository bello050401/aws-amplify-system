import 'server-only';
import {priceEntryWriteItems} from './plannedPriceWrite';
import {ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb,inventoryTable,getInventoryRaw} from './categoryPersistence';
import {buildCountExpression} from './inventoryCountFast';
import {listCategories,toListRow} from './queries';
import {signInventoryListKey} from './listImageUrls';
import {priceEntryCategoryIds,isPriceEntryTarget,type PriceEntryItem} from './plannedPrice';
import {savePlannedPrice,type PriceEntryRecord} from './plannedPriceCore';
import {InventorySaveError} from './conditionalUpdate';
import {clearInventoryCountCache} from './inventoryPage';

async function view(row:PriceEntryRecord):Promise<PriceEntryItem>{
 const image=toListRow(row as Parameters<typeof toListRow>[0]);
 return {id:row.id,sku:String(row.sku??''),name:String(row.name??''),note:String(row.note??''),plannedSalePrice:typeof row.plannedSalePrice==='number'?row.plannedSalePrice:null,updatedAt:row.updatedAt,imageUrl:image.mainImageThumbnailKey?await signInventoryListKey(image.mainImageThumbnailKey):null};
}
/** All matches are returned in one small snapshot, so saves cannot shift a paging offset and skip products. */
export async function listPriceEntry(){
 const ids=priceEntryCategoryIds(await listCategories());if(!ids.length)return [];
 const filter=buildCountExpression({categoryIds:ids});
 const names={...filter.names,'#name':'name','#note':'note','#price':'plannedSalePrice'};
 const segments=await Promise.all(Array.from({length:4},async(_,segment)=>{
  const rows:PriceEntryRecord[]=[];let cursor:Record<string,unknown>|undefined;
  for(let page=0;page<100;page++){
   const result=await inventoryDdb.send(new ScanCommand({TableName:inventoryTable('Inventory'),Segment:segment,TotalSegments:4,ExclusiveStartKey:cursor,
    ProjectionExpression:'id, sku, #name, #note, #price, updatedAt, listUpdatedAt, categoryId, categoryIds, images, deletedAt, listingPartition',
    FilterExpression:filter.filterExpression+' AND (attribute_not_exists(#price) OR #price = :emptyPrice OR #price = :nullPrice)',ExpressionAttributeNames:names,ExpressionAttributeValues:{...filter.values,':emptyPrice':'',':nullPrice':null}}));
   rows.push(...(result.Items??[]) as PriceEntryRecord[]);cursor=result.LastEvaluatedKey;if(!cursor)return rows;
  }throw Error('一覧を最後まで取得できませんでした。再度読み込んでください。');
 }));
 const rows=segments.flat().filter(row=>isPriceEntryTarget(row,ids)).sort((a,b)=>String(b.listUpdatedAt??b.updatedAt).localeCompare(String(a.listUpdatedAt??a.updatedAt))||a.id.localeCompare(b.id));
 return Promise.all(rows.map(view));
}
export async function updatePriceEntry(raw:unknown,actor:string){
 const row=await savePlannedPrice({get:async id=>await getInventoryRaw(id) as PriceEntryRecord|undefined,categories:listCategories,save:async(before,patch,who)=>{
  try{await inventoryDdb.send(new TransactWriteCommand({TransactItems:priceEntryWriteItems(before,patch,who,inventoryTable)}));}
  catch(error){throw new InventorySaveError(error instanceof Error&&error.name==='TransactionCanceledException'?'CONFLICT':'UNCONFIRMED');}
 }},raw,actor);
 clearInventoryCountCache();return view(row);
}

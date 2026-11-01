import 'server-only';
import {priceEntryWriteItems} from './plannedPriceWrite';
import {TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb,inventoryTable,getInventoryRaw} from './categoryPersistence';
import {readPriceEntryRecords} from './plannedPriceRead';
import {listCategories,toListRow} from './queries';
import {signInventoryListKey} from './listImageUrls';
import {priceEntryCategoryIds,type PriceEntryItem} from './plannedPrice';
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
 const rows=await readPriceEntryRecords(inventoryDdb,inventoryTable('Inventory'),ids);
 return Promise.all(rows.map(view));
}
export async function updatePriceEntry(raw:unknown,actor:string){
 const row=await savePlannedPrice({get:async id=>await getInventoryRaw(id) as PriceEntryRecord|undefined,categories:listCategories,save:async(before,patch,who)=>{
  try{await inventoryDdb.send(new TransactWriteCommand({TransactItems:priceEntryWriteItems(before,patch,who,inventoryTable)}));}
  catch(error){throw new InventorySaveError(error instanceof Error&&error.name==='TransactionCanceledException'?'CONFLICT':'UNCONFIRMED');}
 }},raw,actor);
 clearInventoryCountCache();return view(row);
}

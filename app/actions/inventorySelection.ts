'use server';
import {inventoryVerifiedReadSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {readInventoryBatch} from '@/lib/inventory/batchRead';
import {canHardDeleteInventory} from '@/lib/amplify/requireInventoryUser';
export async function inventorySelectionDetails(ids:string[]){
 const session=await inventoryVerifiedReadSession();if(!session)throw Error('ログインが必要です。');
 if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw Error('商品を1,000件以内で選択してください。');
 const unique=[...new Set(ids)],rows=await readInventoryBatch(inventoryDdb,inventoryTable('Inventory'),unique,undefined,['id','name','sku','barcode','quantity','updatedAt','deletedAt','outboundBatchId','outboundArrivalBatchId','listingPartition']);
 return {canDelete:canHardDeleteInventory(session.role as "ADMIN"|"EDITOR"|"VIEWER"),items:unique.map(id=>{const r=rows.get(id);if(!r||r.deletedAt||r.listingPartition==='MERGED')throw Error('選択した商品が削除・合算されています。一覧を読み直してください。');return {id,name:String(r.name),sku:String(r.sku??''),barcode:String(r.barcode??''),quantity:Number(r.quantity??0),updatedAt:String(r.updatedAt),reserved:!!(r.outboundBatchId||r.outboundArrivalBatchId)};})};
}

import 'server-only';
import {getInventoryRaw} from '@/lib/inventory/categoryPersistence';

/** Called after the listing claim, before any BASE create request. */
export async function baseCreateInventoryIsCurrent(expected:{id:string;updatedAt:string;quantity:number}):Promise<boolean>{
 if(typeof expected.updatedAt!=='string'||!expected.updatedAt)return false;
 const current=await getInventoryRaw(expected.id);
 if(!current||current.id!==expected.id||current.updatedAt!==expected.updatedAt||current.quantity!==expected.quantity||!Number.isSafeInteger(current.quantity)||current.quantity<1||current.saleEndDate||current.deletedAt||current.isDeleted||current.listingPartition==='MERGED'||current.outboundBatchId||current.outboundArrivalBatchId)return false;
 try{
  const custom=typeof current.customFields==='string'?JSON.parse(current.customFields):current.customFields;
  return custom?.__belloYahooPayment?.state!=='WAITING';
 }catch{return false;}
}

export const BASE_CREATE_INVENTORY_CHANGED='在庫が変更されたか、最新の状態を確認できませんでした。商品を読み込み直してください。BASEには送信していません。';

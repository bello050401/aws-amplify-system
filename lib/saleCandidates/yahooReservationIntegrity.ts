import {inventoryCategoryIds,type CategoryRecord} from '../inventory/categories';
import {parseCustomFields} from '../inventory/customFieldsCodecCore';
import type {SaleCandidate} from './model';

type ReservationInventory = CategoryRecord & {
 id?:string|null; quantity?:number|null; market?:string|null; externalProductId?:string|null;
 saleEndDate?:string|null; deletedAt?:string|null; listingPartition?:string|null;
 outboundBatchId?:string|null; outboundArrivalBatchId?:string|null; customFields?:unknown;
};
export const YAHOO_RESERVATION_CHANGED='在庫分け・売却情報が変更されています。二重処理を避けて自動更新を保留しています。';
const sameIds=(a:string[],b:unknown)=>Array.isArray(b)&&b.every(x=>typeof x==='string')&&
 JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());

/** Read-only display diagnostic. A sold category is not evidence of payment or
 * authority to deduct stock again. Never mutate the candidate/reservation here. */
export function yahooReservationWarning(candidate:SaleCandidate,item:ReservationInventory|null|undefined):string|undefined {
 const receipt=candidate.result;
 if(candidate.channel!=='YAHOO'||candidate.state!=='DONE'||candidate.yahooPaymentState!=='WAITING'||!receipt?.quantityDeferred)return undefined;
 if(!Number.isSafeInteger(receipt.soldQuantity)||receipt.soldQuantity<1||!Number.isSafeInteger(receipt.remainingQuantity)||receipt.remainingQuantity<0||
   receipt.soldQuantity+receipt.remainingQuantity!==receipt.sourceQuantity)return YAHOO_RESERVATION_CHANGED;
 if(!item||item.deletedAt||item.listingPartition==='MERGED'||item.outboundBatchId||item.outboundArrivalBatchId||
   item.id!==receipt.sourceId||receipt.sourceId!==receipt.soldId)return YAHOO_RESERVATION_CHANGED;
 const marker=parseCustomFields(item.customFields)?.__belloYahooPayment as Record<string,unknown>|undefined;
 const request=marker?.request as Record<string,unknown>|undefined;
 if(!marker||marker.state!=='WAITING'||marker.quantityDeferred!==true||marker.candidateId!==candidate.id||marker.auctionId!==candidate.orderId||
   !Number.isSafeInteger(marker.sourceQuantity)||Number(marker.sourceQuantity)<1||marker.sourceQuantity!==receipt.sourceQuantity||
   item.quantity!==marker.sourceQuantity||!sameIds(inventoryCategoryIds(item),marker.waitingCategoryIds)||
   (item.market??'')!==marker.sourceMarket||(item.externalProductId??'')!==marker.sourceExternalProductId||item.saleEndDate||
   !request||request.inventoryId!==receipt.sourceId||request.sourceCandidateId!==candidate.id||request.quantity!==receipt.soldQuantity||
   request.externalProductId!==candidate.orderId||request.market!=='ヤフオク')return YAHOO_RESERVATION_CHANGED;
 return undefined;
}

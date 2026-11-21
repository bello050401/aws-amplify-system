import type {SaleCandidate} from './model';
const custom=(row:Record<string,unknown>)=>{try{return typeof row.customFields==='string'?JSON.parse(row.customFields):row.customFields??{};}catch{return {};}};
/** The only inventory-version successor authorized for a previously reserved Yahoo sale. */
export function canContinueAfterYahooPayment(c:SaleCandidate|undefined,source:Record<string,unknown>|undefined,sold:Record<string,unknown>|undefined,version:string,remaining:number){
 const r=c?.result;
 if(!c||c.state!=='DONE'||c.channel!=='YAHOO'||c.yahooPaymentState!=='APPLIED'||c.yahooReservationVersion!==version||!r||r.quantityDeferred||r.remainingQuantity!==remaining||!source||!sold||source.id!==r.sourceId||sold.id!==r.soldId||source.updatedAt!==r.updatedAt||sold.updatedAt!==r.updatedAt||source.isDeleted||source.deletedAt||sold.isDeleted||sold.deletedAt)return false;
 if(source.quantity!==(r.sourceId===r.soldId?r.soldQuantity:r.remainingQuantity)||sold.quantity!==r.soldQuantity||sold.externalProductId!==c.orderId)return false;
 const sale=custom(sold).__belloSale,payment=custom(sold).__belloYahooPayment;
 return sale?.sourceInventoryId===r.sourceId&&sale.physicalQuantity===r.soldQuantity&&payment?.state==='APPLIED'&&payment.candidateId===c.id&&payment.auctionId===c.orderId;
}

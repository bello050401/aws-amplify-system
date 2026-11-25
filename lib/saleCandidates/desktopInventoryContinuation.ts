import {createHash} from 'node:crypto';
import {inventoryCategoryIds} from '../inventory/categories';
import {parseCustomFields} from '../inventory/customFieldsCodecCore';
import {desktopSnapshot,type DesktopJob,type DesktopRequest} from './desktopJobModel';
import type {SaleCandidate} from './model';
import type {YahooStockReservation} from './yahooPaymentModel';

type Row=Record<string,unknown>;
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
/** Version-independent stock proof, captured by the server when a new receipt is
 * created. Notes, cost and location may change; stock/order/identity may not. */
export function desktopInventoryFingerprint(item:Row):string|undefined {
 const custom=parseCustomFields(item.customFields);
 if(item.customFields&& !custom)return undefined;
 const fields=['id','sku','sourceSystem','sourceInventoryId','quantity','unit','market','externalProductId','saleEndDate','listingPartition','deletedAt','isDeleted','outboundBatchId','outboundArrivalBatchId'];
 const identity=Object.fromEntries(fields.map(key=>[key,item[key]??null]));
 return createHash('sha256').update(JSON.stringify(canonical({version:1,...identity,categoryIds:inventoryCategoryIds(item).sort(),payment:custom?.__belloYahooPayment??null,sale:custom?.__belloSale??null,split:custom?.__belloStockSplit??null}))).digest('hex');
}
/** This is permission to refresh an idle snapshot, never permission to sell or
 * write to an EC site. Claim/start-write still validate the current binding. */
export function canContinueDesktopInventory(job:DesktopJob,request:DesktopRequest,c:SaleCandidate|undefined,item:Row):boolean {
 if(job.purpose!=='STOCK'||job.writeStartedAt&&job.state!=='COMPLETE'||!['WAITING','COMPLETE'].includes(job.state)||!job.inventoryFingerprint||job.inventoryFingerprint!==request.inventoryFingerprint||request.inventoryFingerprint!==desktopInventoryFingerprint(item)||job.snapshot!==desktopSnapshot(job)||desktopSnapshot({...request,inventoryVersion:job.inventoryVersion})!==job.snapshot)return false;
 const r=c?.result;
 if(!c||c.state!=='DONE'||c.id!==job.candidateId||c.orderId!==job.orderId||(c.orderLineId??'')!==job.orderLineId||!r||r.sourceId!==job.inventoryId||item.id!==job.inventoryId||item.updatedAt!==request.inventoryVersion||r.remainingQuantity!==job.targetQuantity||item.deletedAt||item.isDeleted||item.listingPartition==='MERGED'||item.outboundBatchId||item.outboundArrivalBatchId)return false;
 if(r.quantityDeferred){
  const marker=parseCustomFields(item.customFields)?.__belloYahooPayment as YahooStockReservation|undefined;
  return c.channel==='YAHOO'&&c.yahooPaymentState==='WAITING'&&r.sourceId===r.soldId&&Number.isSafeInteger(r.sourceQuantity)&&item.quantity===r.sourceQuantity&&r.sourceQuantity===r.remainingQuantity+r.soldQuantity&&marker?.state==='WAITING'&&marker.quantityDeferred===true&&marker.candidateId===c.id&&marker.auctionId===c.orderId&&marker.sourceQuantity===r.sourceQuantity&&marker.sourceMarket===(item.market??'')&&marker.sourceExternalProductId===(item.externalProductId??'')&&marker.request?.inventoryId===item.id&&marker.request.sourceCandidateId===c.id&&marker.request.quantity===r.soldQuantity&&!item.saleEndDate;
 }
 return item.quantity===(r.sourceId===r.soldId?r.soldQuantity:r.remainingQuantity);
}

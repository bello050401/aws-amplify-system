import type {SaleCandidate} from './model';
import {comparableDesktopTitle,type DesktopEvidence,type DesktopJob} from './desktopJobModel';

/** Only a standalone dash separator may differ. Never erase variant words, model hyphens or dimensions. */
export function sameBoundDesktopTitle(inventoryTitle:string,observedTitle:string):boolean {
 const key=(s:string)=>comparableDesktopTitle(s).replace(/(^|\s)[\-\u2010-\u2015](?=\s|$)/gu,' ').replace(/\s+/g,' ').trim();
 const left=key(inventoryTitle),right=key(observedTitle);
 return !!left&&left===right;
}
export function assertDesktopIdentificationOrder(job:DesktopJob,c:SaleCandidate|undefined):asserts c is SaleCandidate {
 if(c?.state==='DONE'&&c.result)throw Error('DESKTOP_ORDER_ALREADY_COMPLETED');
 if(!c||c.state!=='PENDING'||c.source!=='GMAIL'||c.channel!=='MERCARI'||c.senderAuthenticated!==true||c.id!==job.candidateId||c.orderId!==job.orderId||(c.orderLineId??'')!==job.orderLineId||c.mercariOrderUrl!==job.orderUrl||c.mercariShopId!==job.shopId||c.name!==job.title||c.quantity!==job.soldQuantity||c.unitPrice!==job.unitPrice)throw Error('DESKTOP_ORDER_CHANGED');
}
/** Formatting tolerance requires the CURRENT exact listing binding; photo attestation never replaces it. */
export function assertDesktopIdentificationInventory(c:SaleCandidate,item:Record<string,unknown>|null|undefined,imageKeys:readonly string[],e:DesktopEvidence,boundExternalId?:string|null):void {
 if(c.externalListingId&&c.externalListingId!==e.externalId)throw Error('DESKTOP_IDENTITY_CHANGED');
 if(!item||item.id!==e.inventoryId||item.isDeleted||item.deletedAt||item.updatedAt!==e.inventoryVersion)throw Error('DESKTOP_STALE_INVENTORY');
 if(!imageKeys.includes(e.expectedImageKey))throw Error('DESKTOP_IMAGE_CHANGED');
 const title=String(item.name??'');
 if(comparableDesktopTitle(title)===comparableDesktopTitle(e.observedTitle))return;
 if(!sameBoundDesktopTitle(title,e.observedTitle))throw Error('DESKTOP_TITLE_MISMATCH');
 if(boundExternalId!==e.externalId)throw Error('DESKTOP_BINDING_REQUIRED');
}

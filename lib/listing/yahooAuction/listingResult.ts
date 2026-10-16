export type YahooListingResult = {inventoryId:string;auctionId:string;title:string;priceYen:number;quantity:number;
  remoteStatus:'open'|'closed'|'cancelled';bids:number;checkedAt:string;revision:number};
export function parseYahooListingResult(value:unknown):YahooListingResult|null {
  if(!value||typeof value!=='object')return null;
  const r=value as YahooListingResult;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.inventoryId)||!/^[a-z][0-9]{8,12}$/.test(r.auctionId)||
    typeof r.title!=='string'||!r.title||!Number.isSafeInteger(r.priceYen)||r.priceYen<1||
    !Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>9||!['open','closed','cancelled'].includes(r.remoteStatus)||
    !Number.isSafeInteger(r.bids)||r.bids<0||!Number.isFinite(Date.parse(r.checkedAt))||
    !Number.isSafeInteger(r.revision)||r.revision<1)return null;
  return {inventoryId:r.inventoryId,auctionId:r.auctionId,title:r.title,priceYen:r.priceYen,quantity:r.quantity,
    remoteStatus:r.remoteStatus,bids:r.bids,checkedAt:r.checkedAt,revision:r.revision};
}

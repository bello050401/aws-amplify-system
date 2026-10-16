import "server-only";
import { parse, type DefaultTreeAdapterMap } from "parse5";
export const yahooAuctionIdValid = (id: unknown): id is string => typeof id === "string" && /^[a-z][0-9]{8,12}$/.test(id);
export type YahooListingEvidence = { auctionId: string; title: string; priceYen: number; quantity: number;
  status: "open" | "closed" | "cancelled"; bids: number; bidders: number; highestBidders: number; owned: true; checkedAt: string };
export function parseListingEvidence(html: string, auctionId: string): YahooListingEvidence | null {
  if (!yahooAuctionIdValid(auctionId) || Buffer.byteLength(html)>2*1024*1024) return null;
  try {
    const pending: DefaultTreeAdapterMap['node'][]=[parse(html)], scripts: string[]=[]; let count=0;
    while(pending.length) {
      const n=pending.pop()!; if(++count>30_000)return null;
      if('tagName'in n && n.tagName==='script' && n.attrs.some(a=>a.name==='id'&&a.value==='__NEXT_DATA__'))
        scripts.push(n.childNodes.map(c=>'value'in c?c.value:'').join(''));
      if('childNodes'in n)pending.push(...n.childNodes);
    }
    if(scripts.length!==1)return null;
    const d=JSON.parse(scripts[0]).props.pageProps.initialState.item.detail.item;
    if(d.auctionId!==auctionId || typeof d.title!=='string' || !d.title || [...d.title].length>65 ||
      !Number.isSafeInteger(d.price) || d.price<1 || !Number.isSafeInteger(d.quantity) || d.quantity<1 || d.quantity>9 ||
      !['open','closed','cancelled'].includes(d.status) || !d.amISellerInfo || typeof d.amISellerInfo!=='object' ||
      ![d.bids,d.biddersNum,d.highestBidders?.totalHighestBidders].every(n=>Number.isSafeInteger(n)&&n>=0))return null;
    return {auctionId,title:d.title,priceYen:d.price,quantity:d.quantity,status:d.status,bids:d.bids,bidders:d.biddersNum,
      highestBidders:d.highestBidders.totalHighestBidders,owned:true,checkedAt:new Date().toISOString()};
  }catch{return null;}
}
/** Observed cancellation preview: omitted fee means zero, exactly as the site's
 * hasCancelFee test. Unknown fee fields/categories fail closed. */
export function zeroFeeCancellationPreview(data: unknown, expected: YahooListingEvidence): boolean {
  if (!data || typeof data!=='object')return false;
  const d=data as {auctionId?:unknown;title?:unknown;categoryInfo?:{isSubmitFeeCategory?:unknown};feeInfo?:{fee?:unknown}};
  return d.auctionId===expected.auctionId && d.title===expected.title && d.categoryInfo?.isSubmitFeeCategory===false &&
    !!d.feeInfo && typeof d.feeInfo==='object' && !Array.isArray(d.feeInfo) &&
    Object.keys(d.feeInfo).every(k=>k==='fee') && (d.feeInfo.fee===undefined || d.feeInfo.fee===0);
}
export function canCancelWithoutBids(value: YahooListingEvidence): boolean {
  return value.owned===true && value.status==='open' && value.bids===0 && value.bidders===0 && value.highestBidders===0;
}

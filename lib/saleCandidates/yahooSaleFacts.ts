import type {SaleCandidate} from './model';
import type {YahooListingEvidence} from '../listing/yahooAuction/webHttpListing';
import type {YahooPublicSaleEvidence} from './yahooPublicSaleEvidence';
export type YahooSaleOwnership={inventoryId:string;inventoryVersion:string;bindingCheckedAt:string};

/** Real Yahoo notices omit sold quantity. A closed owned auction with one
 * offered unit and one successful bidder corroborates one sold unit. An open
 * page, remaining count, multiple offered units or cancellation never does. */
export function corroborateYahooSale(c:SaleCandidate,e:YahooListingEvidence,now=Date.now()):SaleCandidate|null {
 const checked=Date.parse(e.checkedAt);
 if(c.channel!=='YAHOO'||c.source!=='GMAIL'||c.state!=='PENDING'||c.senderAuthenticated!==true||!c.yahooAuthenticatedWonAt||!Number.isFinite(Date.parse(c.yahooAuthenticatedWonAt))||!c.yahooEvents?.WON||c.externalListingId!==c.orderId||e.auctionId!==c.orderId||e.owned!==true||e.status!=='closed'||e.quantity!==1||e.highestBidders!==1||e.bids<1||e.bidders<1||c.unitPrice!==e.priceYen||c.quantity!==null&&c.quantity!==1||!Number.isFinite(checked)||checked>now+60000||checked<now-300000||c.warnings.some(w=>/異なる|取引ナビで/.test(w)))return null;
 if(c.quantity===1&&c.verifiedSaleFacts)return c;
 return {...c,quantity:1,verifiedSaleFacts:true,warnings:c.warnings.filter(w=>!w.startsWith('落札数量はメールから確定できません')),yahooSaleEvidence:{auctionId:e.auctionId,quantity:1,priceYen:e.priceYen,checkedAt:e.checkedAt,source:'OWNED_CLOSED_LISTING'}};
}
/** Legacy seller ownership comes from the authenticated WON notice and exact live eConveni binding,
 * independently of a public page. This proof is never promoted to owned:true. */
export function corroborateLinkedYahooSale(c:SaleCandidate,e:YahooPublicSaleEvidence,link:YahooSaleOwnership,now=Date.now()):SaleCandidate|null{
 const checked=Date.parse(e.checkedAt),bound=Date.parse(link.bindingCheckedAt);
 if(c.channel!=='YAHOO'||c.source!=='GMAIL'||c.state!=='PENDING'||c.senderAuthenticated!==true||c.identifierType!=='AUCTION'||!c.yahooAuthenticatedWonAt||!Number.isFinite(Date.parse(c.yahooAuthenticatedWonAt))||!c.yahooEvents?.WON||!Number.isFinite(Date.parse(c.yahooEvents.WON))||c.orderLineCount!==1||c.externalListingId!==c.orderId||e.kind!=='PUBLIC_LISTING'||e.auctionId!==c.orderId||e.status!=='closed'||e.quantity!==1||e.highestBidders!==1||e.bids<1||e.bidders<1||c.unitPrice!==e.priceYen||c.quantity!==null&&c.quantity!==1||!Number.isFinite(checked)||checked>now+60000||checked<now-300000||!Number.isFinite(bound)||bound>now+60000||bound<now-300000||!link.inventoryId||!Number.isFinite(Date.parse(link.inventoryVersion))||c.warnings.some(w=>/異なる|取引ナビで/.test(w)))return null;
 return {...c,quantity:1,verifiedSaleFacts:true,warnings:c.warnings.filter(w=>!w.startsWith('落札数量はメールから確定できません')),yahooSaleEvidence:{auctionId:e.auctionId,quantity:1,priceYen:e.priceYen,checkedAt:e.checkedAt,source:'TRUSTED_NOTICE_LINKED_CLOSED_LISTING',...link}};
}

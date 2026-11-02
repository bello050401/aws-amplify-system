import type {SoldOutRequest} from '../inventory/soldOutInput';
import type {SaleCandidate} from './model';

export type YahooPaymentPlan={candidateId:string;auctionId:string;waiting:boolean;paidAt?:string};
export const YAHOO_PAYMENT_QUEUE_STATE='YAHOO_PAYMENT_PENDING';
export const yahooPaymentKey=(candidateId:string)=>'YAHOO_PAYMENT:'+candidateId;
export const paymentDate=(at:string)=>new Date(Date.parse(at)+9*3600000).toISOString().slice(0,10);
/** The server obtains this candidate from its own store, never from submitted form data. */
export function yahooPaymentPlan(candidate?:SaleCandidate):YahooPaymentPlan|undefined {
 if(candidate?.channel!=='YAHOO'||candidate.source!=='GMAIL')return undefined;
 if(candidate.identifierType!=='AUCTION'||!(/^[a-z][0-9]{6,15}$/i).test(candidate.orderId))throw Error('YAHOO_PAYMENT_ID_INVALID');
 const at=candidate.yahooPaymentNotice?.receivedAt;
 const paidAt=at&&Number.isFinite(Date.parse(at))?at:undefined;
 return {candidateId:candidate.id,auctionId:candidate.orderId,waiting:!paidAt,...(paidAt?{paidAt}:{})};
}

/** Durable validated request used only when the payment worker settles stock. */
export type YahooStockReservation={
 state:'WAITING';quantityDeferred:true;candidateId:string;auctionId:string;sourceQuantity:number;
 sourceMarket:string;sourceExternalProductId:string;beforeCategoryIds:string[];waitingCategoryIds:string[];
 unpaidCategoryId:string;request:SoldOutRequest;
};

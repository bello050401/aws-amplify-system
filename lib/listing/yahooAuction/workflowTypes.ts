import type { YahooListingResult } from './listingResult';
export type YahooWorkflowView = {
  stage: 'IDLE'|'PREPARING'|'IMAGE_PENDING'|'READY'|'PUBLISH_PENDING'|'CANCEL_PENDING'|'VERIFY_REQUIRED';
  uploaded: number; imageCount: number; confirmationId: string|null;
  listing: YahooListingResult|null; waitUntil: number; error: string|null;
  confirmation: {title:string;priceYen:number;quantity:number;category:string;endAtJst:string;shipping:string;relist:boolean}|null;
};
export type YahooWorkflowResult = {ok:true;view:YahooWorkflowView}|{ok:false;code:string;waitUntil?:number};

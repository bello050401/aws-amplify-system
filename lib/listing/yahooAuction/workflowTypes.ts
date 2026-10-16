import type { YahooListingResult } from './listingResult';
export type YahooWorkflowView = {
  stage: 'IDLE'|'PREPARING'|'IMAGE_PENDING'|'READY'|'PUBLISH_PENDING'|'CANCEL_PENDING'|'VERIFY_REQUIRED';
  uploaded: number; imageCount: number; confirmationId: string|null;
  listing: YahooListingResult|null; waitUntil: number; error: string|null;
  newListing: boolean; previousListings: YahooListingResult[];
  confirmation: {title:string;priceYen:number;quantity:number;category:string;endAtJst:string;shipping:string;relist:boolean;imageUrls:string[]}|null;
};
export type YahooWorkflowResult = {ok:true;view:YahooWorkflowView}|{ok:false;code:string;waitUntil?:number};

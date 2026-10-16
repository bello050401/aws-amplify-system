"use server";
import { canEditInventory, getInventoryRole } from '@/lib/amplify/requireInventoryUser';
import { inventoryAuthMode, serverDataClient } from '@/lib/amplify/dataClient';
import { readYahooRuntimeSession } from '@/lib/listing/yahooAuction/webHttpRuntime';
import { yahooInventoryIdValid } from '@/lib/listing/yahooAuction/preparation';
import { parseYahooListingResult, type YahooListingResult } from '@/lib/listing/yahooAuction/listingResult';
type Result={ok:true;listing:YahooListingResult|null}|{ok:false;code:string};
async function read(inventoryId:string) {
  const r=await serverDataClient.models.YahooAuctionListing.get({inventoryId},inventoryAuthMode);
  if(r.errors?.length)throw Error();
  const parsed=r.data?parseYahooListingResult(r.data):null;
  if(r.data&&!parsed)throw Error();return parsed;
}
export async function getYahooListingResultAction(inventoryId:string):Promise<Result> {
  if(!canEditInventory(await getInventoryRole()))return {ok:false,code:'FORBIDDEN'};
  if(!yahooInventoryIdValid(inventoryId))return {ok:false,code:'INVALID_INPUT'};
  try{return {ok:true,listing:await read(inventoryId)};}catch{return {ok:false,code:'RESULT_UNAVAILABLE'};}
}
/** Reads only the server-stored auction ID; callers cannot replace the binding.
 * No publish/cancel is performed. Readback persists with a revision condition. */
export async function refreshYahooListingResultAction(inventoryId:string):Promise<Result> {
  const current=await getYahooListingResultAction(inventoryId);
  if(!current.ok||!current.listing)return current;
  const previous=current.listing;
  const runtime=await readYahooRuntimeSession();if(!runtime.ok)return runtime;
  const remote=await runtime.session.inspectListing(previous.auctionId);
  if(!remote.ok)return remote;
  if(remote.value.title!==previous.title||remote.value.priceYen!==previous.priceYen||remote.value.quantity!==previous.quantity)
    return {ok:false,code:'REMOTE_CONTENT_CHANGED'};
  const next:YahooListingResult={...previous,remoteStatus:remote.value.status,bids:remote.value.bids,
    checkedAt:remote.value.checkedAt,revision:previous.revision+1};
  try {
    const r=await serverDataClient.graphql({query:`mutation RefreshYahooResult($input: UpdateYahooAuctionListingInput!, $condition: ModelYahooAuctionListingConditionInput) {
      updateYahooAuctionListing(input:$input,condition:$condition) { inventoryId auctionId title priceYen quantity remoteStatus bids checkedAt revision }
    }`,variables:{input:next,condition:{revision:{eq:previous.revision},auctionId:{eq:previous.auctionId}}},authMode:'userPool'}) as {data?:{updateYahooAuctionListing?:unknown};errors?:unknown};
    const parsed=r.errors?null:parseYahooListingResult(r.data?.updateYahooAuctionListing);
    if(parsed&&parsed.revision===next.revision&&parsed.auctionId===next.auctionId&&parsed.checkedAt===next.checkedAt)
      return {ok:true,listing:parsed};
  }catch{/* Lost acknowledgement: read once; never blindly repeat mutation. */}
  try{const final=await read(inventoryId);if(final&&final.auctionId===next.auctionId&&final.revision>=next.revision)return {ok:true,listing:final};}catch{}
  return {ok:false,code:'RESULT_UNAVAILABLE'};
}

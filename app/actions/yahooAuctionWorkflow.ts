"use server";
import sharp from 'sharp';
import {canEditInventory,getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {inventoryAuthMode,serverDataClient} from '@/lib/amplify/dataClient';
import {resolveListingImageDownloadUrl} from '@/lib/listing/mercari/csv/buildExportRows';
import type {ListingImageRef} from '@/lib/listing/types';
import {yahooInventoryIdValid} from '@/lib/listing/yahooAuction/preparation';
import {YahooWorkflowStore,WorkflowFailure} from '@/lib/listing/yahooAuction/workflowStore';
import {YahooWorkflow,workflowView} from '@/lib/listing/yahooAuction/workflow';
import {readYahooRuntimeSession} from '@/lib/listing/yahooAuction/webHttpRuntime';
import {parseYahooListingResult,type YahooListingResult} from '@/lib/listing/yahooAuction/listingResult';
import type {YahooWorkflowResult} from '@/lib/listing/yahooAuction/workflowTypes';
import {getYahooAuctionPreparationAction} from './yahooAuctionPreparation';

async function authorize(id:string){
  if(!canEditInventory(await getInventoryRole()))throw new WorkflowFailure('FORBIDDEN');
  if(!yahooInventoryIdValid(id))throw new WorkflowFailure('INVALID_INPUT');
}
async function legacy(id:string){
  const r=await serverDataClient.models.YahooAuctionListing.get({inventoryId:id},inventoryAuthMode);
  if(r.errors?.length)throw new WorkflowFailure('RESULT_UNAVAILABLE');
  const value=r.data?parseYahooListingResult(r.data):null;
  if(r.data&&!value)throw new WorkflowFailure('RESULT_UNAVAILABLE');return value;
}
async function mirror(value:YahooListingResult){
  const prior=await legacy(value.inventoryId);
  if(prior&&Date.parse(prior.checkedAt)>Date.parse(value.checkedAt))return;
  const name=prior?'updateYahooAuctionListing':'createYahooAuctionListing';
  const type=prior?'UpdateYahooAuctionListingInput':'CreateYahooAuctionListingInput';
  await serverDataClient.graphql({query:`mutation SaveYahooResult($input:${type}!, $condition:ModelYahooAuctionListingConditionInput){${name}(input:$input,condition:$condition){inventoryId}}`,
    variables:{input:{...value,revision:(prior?.revision??0)+1},condition:prior?{revision:{eq:prior.revision},auctionId:{eq:prior.auctionId}}:{revision:{attributeExists:false}}},authMode:'userPool'});
}
async function imageBytes(ref:ListingImageRef):Promise<Uint8Array>{
  // Ref is from the role-checked saved source, never from the browser request.
  const url=await resolveListingImageDownloadUrl(ref);
  if(!url||new URL(url).protocol!=='https:')throw new WorkflowFailure('IMAGE_UNAVAILABLE');
  const r=await fetch(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});
  if(!r.ok||!r.body)throw new WorkflowFailure('IMAGE_UNAVAILABLE');
  const reader=r.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;
    if(size>20*1024*1024)throw new WorkflowFailure('IMAGE_TOO_LARGE');parts.push(p.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=await sharp(Buffer.concat(parts),{limitInputPixels:40_000_000}).rotate().resize(2000,2000,{fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
  if(bytes.length>5*1024*1024)throw new WorkflowFailure('IMAGE_TOO_LARGE');return bytes;
}
function failure(e:unknown):YahooWorkflowResult{return e instanceof WorkflowFailure?{ok:false,code:e.code,...(e.waitUntil?{waitUntil:e.waitUntil}:{})}:{ok:false,code:'STATE_UNAVAILABLE'};}

export async function getYahooWorkflowAction(id:string):Promise<YahooWorkflowResult>{
  try{await authorize(id);const store=new YahooWorkflowStore(id),state=await store.read();
    const account=await store.account(),view=workflowView(state,(account.lastSentAt??0)+30_000);
    if(!state)view.listing=await legacy(id);
    return {ok:true,view};}catch(e){return failure(e);}
}
async function run(id:string,operation:'PREPARE'|'PUBLISH'|'CANCEL'|'REFRESH',value:unknown,termsAccepted=false):Promise<YahooWorkflowResult>{
  let store:YahooWorkflowStore|undefined,acquired=false;
  try{
    await authorize(id);store=new YahooWorkflowStore(id);await store.acquire();acquired=true;
    const runtime=await readYahooRuntimeSession();if(!runtime.ok)return runtime;
    const flow=new YahooWorkflow(store,runtime.session,async()=>{
      const c=await getYahooAuctionPreparationAction(id);if(!c.ok)throw new WorkflowFailure(c.code);return c.context;
    },imageBytes,()=>legacy(id),mirror);
    await flow.load();
    if(operation==='PREPARE'){
      if(!Number.isSafeInteger(value)||Number(value)<1)throw new WorkflowFailure('INVALID_INPUT');
      await flow.prepare(Number(value));
    } else if(operation==='PUBLISH'){
      if(typeof value!=='string'||value.length>100)throw new WorkflowFailure('INVALID_INPUT');
      await flow.publish(value,termsAccepted);
    } else if(operation==='CANCEL'){
      if(typeof value!=='string')throw new WorkflowFailure('INVALID_INPUT');await flow.cancel(value);
    } else await flow.refresh();
    const account=await store.account();return {ok:true,view:workflowView(flow.state,(account.lastSentAt??0)+30_000)};
  }catch(e){return failure(e);}finally{if(acquired)await store!.release();}
}
export async function prepareYahooPublicationAction(id:string,revision:number){return run(id,'PREPARE',revision);}
export async function publishYahooListingAction(id:string,confirmationId:string,termsAccepted:boolean){return run(id,'PUBLISH',confirmationId,termsAccepted);}
export async function cancelYahooListingAction(id:string,auctionId:string){return run(id,'CANCEL',auctionId);}
export async function reconcileYahooListingAction(id:string){return run(id,'REFRESH',null);}
export async function searchYahooCategoriesAction(query:string){
  if(!canEditInventory(await getInventoryRole()))return {ok:false as const,code:'FORBIDDEN'};
  if(typeof query!=='string'||!query.trim()||query.length>100)return {ok:false as const,code:'INVALID_INPUT'};
  const runtime=await readYahooRuntimeSession();if(!runtime.ok)return runtime;
  return runtime.session.searchCategories(query);
}

import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import type {ListingDraftRecord,ListingImageRef} from '../types';
import {yahooSourceMatches,yahooPreparationIssues,type YahooAuctionSaved} from './preparation';
import type {YahooWebSession} from './webHttpSession';
import type {YahooFixedPreviewInput} from './webHttpPreview';
import type {YahooListingResult} from './listingResult';
import type {YahooListingEvidence} from './webHttpListing';
import {WorkflowFailure,uncertainStage,type WorkflowState,type YahooWorkflowStore} from './workflowStore';
import type {YahooWorkflowView} from './workflowTypes';

type Context={saved:YahooAuctionSaved|null;draft:ListingDraftRecord|null;availableQuantity:number;canPrepare:boolean};
type Store=Pick<YahooWorkflowStore,'pk'|'read'|'commit'|'account'>;
export const payloadHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const condition={NEW:'new',LIKE_NEW:'used10',NO_NOTABLE_DAMAGE:'used20',SLIGHT_DAMAGE:'used40',DAMAGE:'used60',BAD:'used80'} as const;
export function previewInput(saved:YahooAuctionSaved,relistId?:string):YahooFixedPreviewInput {
  const i=saved.payload.input;
  if(i.format!=='FIXED')throw new WorkflowFailure('FIXED_PRICE_ONLY');
  if(!i.condition||!i.priceYen)throw new WorkflowFailure('INVALID_INPUT');
  return {title:i.title,description:i.description,condition:condition[i.condition],priceYen:i.priceYen,quantity:i.quantity,
    categoryId:i.categoryId,closingDateJst:i.endAtJst.slice(0,10),closingHourJst:Number(i.endAtJst.slice(11,13)),
    ...(relistId?{relistId}:{}),shipping:{payer:'seller',method:saved.payload.source.shippingMethod==='KAZAI'?'家財おまかせ便':'佐川急便',prefecture:'11',schedule:'2'}};
}
export function assertCurrent(c:Context,expectedRevision:number){
  if(!c.saved||!c.draft||c.saved.revision!==expectedRevision||!yahooSourceMatches(c.saved.payload.source,c.draft))throw new WorkflowFailure('SOURCE_CHANGED');
  if(!c.canPrepare||c.saved.payload.input.quantity>c.availableQuantity)throw new WorkflowFailure('NOT_ELIGIBLE');
  if(yahooPreparationIssues(c.saved.payload.input,c.saved.payload.source.images.length,c.availableQuantity).length)throw new WorkflowFailure('INVALID_INPUT');
  previewInput(c.saved);
  return c.saved;
}
export function workflowView(s:WorkflowState|null,waitUntil=0):YahooWorkflowView{
  const i=s?.saved?.payload.input;
  return {stage:s?.stage??'IDLE',uploaded:s?.images.length??0,imageCount:s?.saved?.payload.source.images.length??0,
    confirmationId:s?.stage==='READY'?s.jobId:null,listing:s?.listing??null,waitUntil,error:s?.error??null,
    newListing:s?.newListing??false,previousListings:s?.previousListings??[],
    confirmation:s?.stage==='READY'&&i?{title:i.title,priceYen:i.priceYen!,quantity:i.quantity,category:i.categoryName,
      endAtJst:i.endAtJst,shipping:s.saved!.payload.source.shippingMethod==='KAZAI'?'家財おまかせ便':'佐川急便',relist:!!s.relistId,imageUrls:s.images.map(image=>image.url)}:null};
}
const matches=(e:YahooListingEvidence,i:{title:string;priceYen:number|null;quantity:number})=>e.title===i.title&&e.priceYen===i.priceYen&&e.quantity===i.quantity;
export class YahooWorkflow {
  state:WorkflowState|null=null;
  constructor(private store:Store,private session:YahooWebSession,private context:()=>Promise<Context>,
    private image: (ref:ListingImageRef)=>Promise<Uint8Array>,private legacy:()=>Promise<YahooListingResult|null>,
    private mirror:(r:YahooListingResult)=>Promise<void>){ }
  async load(){this.state=await this.store.read();return this.state;}
  private async save(next:WorkflowState,reserve=false){this.state=await this.store.commit(this.state,next,reserve);return this.state;}
  private empty(listing:YahooListingResult|null):WorkflowState{return {pk:this.store.pk,revision:0,stage:'IDLE',jobId:randomUUID(),images:[],listing,
    previousListings:this.state?.previousListings??[],newListing:this.state?.newListing??false,updatedAt:new Date().toISOString()};}
  private async binding(){return this.state?.listing??await this.legacy();}
  private async verifyBinding(listing:YahooListingResult){
    const r=await this.session.inspectListing(listing.auctionId);if(!r.ok)throw new WorkflowFailure(r.code);
    if(!matches(r.value,listing))throw new WorkflowFailure('REMOTE_CONTENT_CHANGED');return r.value;
  }
  private async verifyStopped(listing:YahooListingResult){
    const live=await this.verifyBinding(listing);
    if(live.status!=='cancelled'||live.bids||live.bidders||live.highestBidders)throw new WorkflowFailure('BIDS_OR_STATE_CHANGED');
  }
  private async verifyHistory(){
    // An older listing may have been reopened outside BELLO. Do not publish a
    // second copy if any previously linked listing is no longer stopped.
    for(const prior of this.state?.previousListings??[])await this.verifyStopped(prior);
  }
  async startNew(expectedAuctionId:string,expectedRevision:number){
    const saved=assertCurrent(await this.context(),expectedRevision);
    if(this.state&&this.state.stage!=='IDLE')throw new WorkflowFailure('VERIFY_REQUIRED');
    const listing=await this.binding();
    if(!listing||listing.auctionId!==expectedAuctionId)throw new WorkflowFailure('SOURCE_CHANGED');
    if((this.state?.previousListings?.length??0)>=50)throw new WorkflowFailure('HISTORY_LIMIT');
    await this.verifyHistory();await this.verifyStopped(listing);
    assertCurrent(await this.context(),expectedRevision);
    // Retain the old binding until the new publication is confirmed. This is
    // preparation only: it cannot clear an uncertain send or publish anything.
    await this.save({...this.empty(listing),stage:'PREPARING',newListing:true,saved,
      fingerprint:payloadHash(saved.payload),imageSourceHash:payloadHash(saved.payload.source)});
  }
  private async record(e:YahooListingEvidence){
    const s=this.state!;
    const replaced=s.listing&&s.listing.auctionId!==e.auctionId;
    const previousListings=replaced?[...(s.previousListings??[]),s.listing!]:s.previousListings??[];
    const listing:YahooListingResult={inventoryId:this.store.pk.slice('INVENTORY#'.length),auctionId:e.auctionId,title:e.title,
      priceYen:e.priceYen,quantity:e.quantity,remoteStatus:e.status,bids:e.bids,checkedAt:e.checkedAt,revision:(s.listing?.revision??0)+1};
    await this.save({...s,stage:'IDLE',listing,previousListings,newListing:replaced?false:s.newListing,candidateId:undefined,error:undefined});
    try{await this.mirror(listing);}catch{/* Authoritative durable result remains available; refresh repairs the display projection. */}
  }
  /** Advances at most ONE image upload per call; the UI can resume after reload.
   * Every request has fresh authentication and a durable pre-send record. */
  async prepare(expectedRevision:number){
    const saved=assertCurrent(await this.context(),expectedRevision),hash=payloadHash(saved.payload);
    if(this.state&&uncertainStage(this.state.stage))throw new WorkflowFailure('VERIFY_REQUIRED');
    const binding=await this.binding();
    await this.verifyHistory();
    if(binding)await this.verifyStopped(binding);
    if(!this.state||this.state.fingerprint!==hash||this.state.stage==='IDLE'){
      const imageSourceHash=payloadHash(saved.payload.source);
      const old=this.state;
      await this.save({...this.empty(binding),saved,fingerprint:hash,imageSourceHash,stage:'PREPARING',
        relistId:old?.newListing?undefined:binding?.auctionId,images:old?.imageSourceHash===imageSourceHash?old.images:[]});
    }
    let s=this.state!;
    if(s.stage==='READY'&&Date.now()-(s.readyAt??0)<15*60_000)return;
    if(binding&&!s.newListing){
      // Yahoo locks prior pictures during relisting. Display the exact remote
      // images for approval, without silently replacing or duplicating them.
      const priorImages=await this.session.inspectRelistingImages(previewInput(saved,binding.auctionId));
      if(!priorImages.ok)throw new WorkflowFailure(priorImages.code);
      await this.save({...s,images:priorImages.value});s=this.state!;
    }
    if(!s.relistId&&s.images.length<saved.payload.source.images.length){
      const bytes=await this.image(saved.payload.source.images[s.images.length]);
      const inspected=await this.session.inspectInput();if(!inspected.ok)throw new WorkflowFailure(inspected.code);
      assertCurrent(await this.context(),expectedRevision);
      await this.save({...s,stage:'IMAGE_PENDING',lastOperation:'IMAGE',error:undefined},true);
      const result=await this.session.probeImageUpload(bytes,`bello-${s.jobId}-${s.images.length+1}.jpg`);
      if(!result.ok){await this.save({...this.state!,stage:'VERIFY_REQUIRED',error:result.code});return;}
      await this.save({...this.state!,stage:'PREPARING',images:[...s.images,result.value]});return;
    }
    const preview=await this.session.previewFixedListing(previewInput(saved,s.relistId),s.images);
    if(!preview.ok)throw new WorkflowFailure(preview.code);
    assertCurrent(await this.context(),expectedRevision);
    await this.save({...this.state!,stage:'READY',readyAt:Date.now(),error:undefined});
  }
  async publish(confirmationId:string,termsAccepted:boolean){
    const s=this.state;
    if(!s||s.stage!=='READY'||s.jobId!==confirmationId||termsAccepted!==true)throw new WorkflowFailure('APPROVAL_MISMATCH');
    if(!s.readyAt||Date.now()-s.readyAt>15*60_000)throw new WorkflowFailure('CONFIRMATION_EXPIRED');
    const saved=assertCurrent(await this.context(),s.saved!.revision);
    if(payloadHash(saved.payload)!==s.fingerprint)throw new WorkflowFailure('SOURCE_CHANGED');
    await this.verifyHistory();
    if(s.listing)await this.verifyStopped(s.listing);
    const preview=await this.session.previewFixedListing(previewInput(saved,s.relistId),s.images);
    if(!preview.ok)throw new WorkflowFailure(preview.code);
    const i=saved.payload.input;
    let reservationError:unknown;
    const result=await this.session.publishPreparedListing({title:i.title,priceYen:i.priceYen!,quantity:i.quantity,termsAccepted:true},async()=>{
      try{assertCurrent(await this.context(),saved.revision);
        await this.save({...this.state!,stage:'PUBLISH_PENDING',lastOperation:'PUBLISH',error:undefined},true);
      }catch(e){reservationError=e;throw e;}
    });
    // beforeSend can fail (including 30-second spacing); no pending reservation
    // means the publication client did not send and READY stays retryable.
    if(this.state?.stage!=='PUBLISH_PENDING')throw reservationError??new WorkflowFailure(result.code);
    const ids='evidence'in result?result.evidence?.candidateAuctionIds??[]:[];
    const candidateId=ids.length===1?ids[0]:undefined;
    await this.save({...this.state!,stage:'VERIFY_REQUIRED',candidateId,error:'PUBLICATION_RESULT_UNKNOWN'});
    if(candidateId)await this.refresh();
  }
  async cancel(expectedAuctionId:string){
    if(this.state&&uncertainStage(this.state.stage))throw new WorkflowFailure('VERIFY_REQUIRED');
    const listing=await this.binding();
    if(!listing||listing.auctionId!==expectedAuctionId)throw new WorkflowFailure('SOURCE_CHANGED');
    if(!this.state)await this.save(this.empty(listing));
    const live=await this.verifyBinding(listing);
    if(live.status==='cancelled'){await this.record(live);return;}
    let reservationError:unknown;
    const result=await this.session.cancelListingWithoutFee(listing.auctionId,listing,async()=>{
      try{await this.save({...this.state!,stage:'CANCEL_PENDING',lastOperation:'CANCEL',error:undefined},true);}
      catch(e){reservationError=e;throw e;}
    });
    if(result.ok){await this.record(result.value);return;}
    if(this.state?.stage==='CANCEL_PENDING')await this.save({...this.state,stage:'VERIFY_REQUIRED',error:result.code});
    else throw reservationError??new WorkflowFailure(result.code);
  }
  async refresh(){
    const s=this.state;
    if(s&&uncertainStage(s.stage)){
      if(s.lastOperation==='IMAGE')throw new WorkflowFailure('IMAGE_RESULT_UNKNOWN');
      const id=s.lastOperation==='PUBLISH'?s.candidateId:s.listing?.auctionId;
      if(!id)throw new WorkflowFailure('VERIFY_REQUIRED');
      const remote=await this.session.inspectListing(id);if(!remote.ok)throw new WorkflowFailure(remote.code);
      const expected=s.lastOperation==='PUBLISH'?s.saved!.payload.input:s.listing!;
      if(s.lastOperation==='PUBLISH'&&s.newListing&&(id===s.listing?.auctionId||s.previousListings?.some(prior=>prior.auctionId===id)))throw new WorkflowFailure('VERIFY_REQUIRED');
      if(!matches(remote.value,expected)||remote.value.status!==(s.lastOperation==='PUBLISH'?'open':'cancelled'))throw new WorkflowFailure('VERIFY_REQUIRED');
      await this.record(remote.value);return;
    }
    const listing=await this.binding();if(!listing)return;
    const live=await this.verifyBinding(listing);
    if(!this.state)await this.save(this.empty(listing));
    await this.record(live);
  }
}

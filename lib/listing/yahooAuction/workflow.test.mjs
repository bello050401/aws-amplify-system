import test from 'node:test';
import assert from 'node:assert/strict';
import {YahooWorkflow,payloadHash,workflowView} from './workflow.ts';
import {WorkflowFailure,YahooWorkflowStore} from './workflowStore.ts';
const id='57b4b2b5-d6ad-435a-b303-5d412405a44c';
const image={url:'https://auctions.c.yimg.jp/test.jpg',width:1200,height:1200};
function setup(options={}){
  const draft={id:'draft',updatedAt:'2026-10-17T00:00:00Z',images:[{storageKey:'inventory/a.jpg',sortOrder:0}],shippingMethod:'KAZAI'};
  const saved={revision:1,updatedAt:draft.updatedAt,payload:{schemaVersion:1,input:{title:'Chair',description:'Good',condition:'NO_NOTABLE_DAMAGE',format:'FIXED',priceYen:99999,buyNowYen:null,quantity:1,categoryId:'2084057261',categoryName:'椅子',endAtJst:new Date(Date.now()+2*86400000).toISOString().slice(0,11)+'22:00',autoExtension:false},source:{draftId:draft.id,draftUpdatedAt:draft.updatedAt,images:draft.images,shippingMethod:'KAZAI'}}};
  let state=null,uploads=0,posts=0,cancels=0,reservations=0,mirrors=0,clock=Date.now(),lastSend=0,revisionOnRead=false;
  let status=options.prior?'cancelled':'open';
  const evidence=()=>({auctionId:'f1248612637',title:'Chair',priceYen:99999,quantity:1,status,bids:0,bidders:0,highestBidders:0,owned:true,checkedAt:new Date().toISOString()});
  const prior=options.prior?{inventoryId:id,...evidence(),remoteStatus:'cancelled',revision:3}:null;
  const store={pk:'INVENTORY#'+id,read:async()=>structuredClone(state),account:async()=>({lastSentAt:lastSend}),commit:async(previous,next,reserve)=>{
    assert.equal(previous?.revision??0,state?.revision??0);
    if(reserve&&clock-lastSend<30000)throw new WorkflowFailure('WAIT_INTERVAL',lastSend+30000);
    if(reserve){reservations++;lastSend=clock;}
    state={...structuredClone(next),revision:(state?.revision??0)+1};
    if(options.lostReservation&&reserve)throw new WorkflowFailure('STATE_UNAVAILABLE');
    return structuredClone(state);
  }};
  const session={inspectInput:async()=>({ok:true,value:{}}),probeImageUpload:async()=>{uploads++;return options.imageUnknown?{ok:false,code:'IMAGE_RESULT_UNKNOWN'}:{ok:true,value:image};},
    previewFixedListing:async(input,images)=>{assert.equal(images.length,1);if(options.prior)assert.equal(input.relistId,prior.auctionId);if(options.sourceRace)revisionOnRead=true;
      return {ok:true,value:{title:input.title,priceYen:input.priceYen,quantity:input.quantity}};},
    publishPreparedListing:async(approval,before)=>{try{await before({});}catch{return {ok:false,code:'ATTEMPT_NOT_RESERVED'};}posts++;status='open';
      if(options.publishUnknown)return {ok:false,code:'PUBLICATION_RESULT_UNKNOWN'};
      return {ok:false,code:'PUBLICATION_READBACK_REQUIRED',evidence:{candidateAuctionIds:['f1248612637']}};},
    inspectListing:async()=>({ok:true,value:evidence()}),inspectRelistingImages:async()=>({ok:true,value:[{...image,url:'https://auctions.c.yimg.jp/prior.jpg'}]}),
    cancelListingWithoutFee:async(auction,expected,before)=>{if(options.bids)return {ok:false,code:'BIDS_OR_STATE_CHANGED'};await before(evidence());cancels++;status='cancelled';return {ok:true,value:evidence()};}
  };
  const make=()=>new YahooWorkflow(store,session,async()=>({saved:revisionOnRead?{...saved,revision:2}:saved,draft,canPrepare:true,availableQuantity:1}),async()=>new Uint8Array([255,216,255]),async()=>prior,async()=>{mirrors++;});
  return {make,saved,get:()=>({state,uploads,posts,cancels,reservations,mirrors}),advance:()=>clock+=31000,setState:s=>state=s};
}
test('prepare uploads once, resumes after process loss, and never publishes without exact confirmation',async()=>{
  const t=setup();let f=t.make();await f.load();await f.prepare(1);assert.equal(t.get().state.stage,'PREPARING');assert.equal(t.get().uploads,1);assert.equal(t.get().posts,0);
  f=t.make();await f.load();await f.prepare(1);assert.equal(t.get().state.stage,'READY');assert.equal(t.get().uploads,1);
  await assert.rejects(f.publish('wrong',true),e=>e.code==='APPROVAL_MISMATCH');
  await assert.rejects(f.publish(f.state.jobId,false),e=>e.code==='APPROVAL_MISMATCH');assert.equal(t.get().posts,0);
  await assert.rejects(f.publish(f.state.jobId,true),e=>e.code==='WAIT_INTERVAL');assert.equal(t.get().posts,0);
  t.advance();await f.publish(f.state.jobId,true);assert.equal(t.get().posts,1);assert.equal(f.state.listing.remoteStatus,'open');assert.equal(t.get().mirrors,1);
  await assert.rejects(f.publish(f.state.jobId,true),e=>e.code==='APPROVAL_MISMATCH');assert.equal(t.get().posts,1);
});
test('image response ambiguity survives reload and cannot be retried',async()=>{
  const t=setup({imageUnknown:true});let f=t.make();await f.load();await f.prepare(1);assert.equal(f.state.stage,'VERIFY_REQUIRED');
  t.advance();f=t.make();await f.load();await assert.rejects(f.prepare(1),e=>e.code==='VERIFY_REQUIRED');assert.equal(t.get().uploads,1);
});
test('lost reservation acknowledgement causes zero sends and leaves durable reconciliation state',async()=>{
  const t=setup({lostReservation:true});const f=t.make();await f.load();await assert.rejects(f.prepare(1),e=>e.code==='STATE_UNAVAILABLE');
  assert.equal(t.get().uploads,0);assert.equal(t.get().state.stage,'IMAGE_PENDING');
});
test('unknown publication result cannot be republished or reset with a new preparation',async()=>{
  const t=setup({publishUnknown:true});let f=t.make();await f.load();await f.prepare(1);await f.prepare(1);t.advance();await f.publish(f.state.jobId,true);
  assert.equal(f.state.stage,'VERIFY_REQUIRED');f=t.make();await f.load();await assert.rejects(f.prepare(1));await assert.rejects(f.publish(f.state.jobId,true));assert.equal(t.get().posts,1);
});
test('stale source and stock checks run before external sends and again after preview',async()=>{
  const t=setup({sourceRace:true});const f=t.make();await f.load();await assert.rejects(f.prepare(2),e=>e.code==='SOURCE_CHANGED');assert.equal(t.get().uploads,0);
  await f.prepare(1);await assert.rejects(f.prepare(1),e=>e.code==='SOURCE_CHANGED');assert.equal(t.get().posts,0);
});
test('publish, stop and relist use the stored ID and retain image assets',async()=>{
  const t=setup();const f=t.make();await f.load();await f.prepare(1);await f.prepare(1);t.advance();await f.publish(f.state.jobId,true);
  await assert.rejects(f.cancel('f0000000000'),e=>e.code==='SOURCE_CHANGED');t.advance();await f.cancel('f1248612637');assert.equal(f.state.listing.remoteStatus,'cancelled');
  t.advance();await f.prepare(1);assert.equal(f.state.stage,'READY');assert.equal(f.state.relistId,'f1248612637');assert.equal(t.get().uploads,1);
});
test('an existing cancelled legacy binding is adopted without creating an unrelated new listing',async()=>{
  const t=setup({prior:true});const f=t.make();await f.load();await f.prepare(1);await f.prepare(1);assert.equal(f.state.relistId,'f1248612637');assert.equal(t.get().posts,0);
  const v=workflowView(f.state);assert.equal(v.confirmation.relist,true);assert.equal('images'in v,false);assert.equal('saved'in v,false);
  assert.equal(t.get().uploads,0);assert.deepEqual(v.confirmation.imageUrls,['https://auctions.c.yimg.jp/prior.jpg']);
});
test('DynamoDB reservation uses one atomic account timestamp and inventory revision transaction',async()=>{
  const commands=[];const transport={send:async c=>{commands.push(c);if(c.constructor.name==='GetCommand')return {Item:{lastSentAt:0}};return {};}};
  const s=new YahooWorkflowStore(id,transport,'test-table');await s.acquire();const state={pk:s.pk,revision:2,stage:'READY',jobId:'test',images:[],listing:null,updatedAt:'now'};
  await s.commit(state,{...state,stage:'PUBLISH_PENDING'},true);
  const tx=commands.find(c=>c.constructor.name==='TransactWriteCommand').input;
  assert.equal(tx.TransactItems.length,2);assert.match(tx.TransactItems[0].Update.ConditionExpression,/leaseUntil > :now/);
  assert.match(tx.TransactItems[0].Update.ConditionExpression,/lastSentAt <= :cutoff/);
  assert.equal(tx.TransactItems[1].Put.ConditionExpression,'revision=:revision');assert.equal(tx.TransactItems[1].Put.Item.stage,'PUBLISH_PENDING');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListingEvidence, zeroFeeCancellationPreview } from './webHttpListing.ts';
import { YahooWebSession } from './webHttpSession.ts';
const id='f1248612637',title='Chair';
const item={auctionId:id,title,price:99999,quantity:1,status:'open',bids:0,biddersNum:0,
  highestBidders:{totalHighestBidders:0},amISellerInfo:{pageView:0}};
const html=(change={})=>`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialState:{item:{detail:{item:{...item,...change}}}}}}})}</script>`;
const page=(change={})=>new Response(html(change),{headers:{'content-type':'text/html'}});
const preview=(change={})=>new Response(JSON.stringify({auctionId:id,title,categoryInfo:{isSubmitFeeCategory:false},feeInfo:{},...change}),{headers:{'content-type':'application/json','x-csrf-token':'private-fresh'}});
const create=fetchImpl=>YahooWebSession.fromStoredSession(JSON.stringify({schemaVersion:1,origin:'https://auctions.yahoo.co.jp',cookieHeader:'session=private',capturedAt:'2026-10-01T00:00:00Z',verifiedAt:'2026-10-01T00:00:00Z'}),{fetchImpl}).value;
test('readback rejects other accounts, malformed data and wrong IDs',()=>{
 assert.equal(parseListingEvidence(html(),id).status,'open');
 for(const c of [{auctionId:'x1234567890'},{amISellerInfo:null},{bids:-1},{quantity:0},{price:'99999'},{status:'unknown'}])assert.equal(parseListingEvidence(html(c),id),null);
 assert.equal(parseListingEvidence(html()+html(),id),null);
});
test('zero fee matches observed omission but fails closed on other fee values',()=>{
 const e=parseListingEvidence(html(),id),p={auctionId:id,title,categoryInfo:{isSubmitFeeCategory:false},feeInfo:{}};
 assert.equal(zeroFeeCancellationPreview(p,e),true);
 for(const feeInfo of [{fee:550},{fee:'0'},{otherFee:0},null,[]])assert.equal(zeroFeeCancellationPreview({...p,feeInfo},e),false);
});

test('HTTP 404 is accepted only with complete matching owned cancellation evidence',async()=>{
 for(const change of [{status:'cancelled'}, {}, {status:'closed'}, {status:'cancelled',amISellerInfo:null}, {status:'cancelled',auctionId:'x1234567890'}]){
  const s=create(async()=>new Response(html(change),{status:404,headers:{'content-type':'text/html'}}));
  const r=await s.inspectListing(id);
  assert.equal(r.ok,change.status==='cancelled'&&change.amISellerInfo!==null&&!change.auctionId);
 }
 const missing=create(async()=>new Response('Not found',{status:404,headers:{'content-type':'text/html'}}));
 assert.equal((await missing.inspectListing(id)).ok,false);
});
test('fee, bids or a late bid prevent any cancellation send',async()=>{
 for(const fault of ['fee','bid','late']){
  let calls=0;
  const s=create(async()=>{calls++;if(calls===1)return page(fault==='bid'?{bids:1}:{});if(calls===2)return preview(fault==='fee'?{feeInfo:{fee:550}}:{});if(calls===3)return page({bids:1});assert.fail('must not PUT')});
  const r=await s.cancelListingWithoutFee(id,{title,priceYen:99999,quantity:1},async()=>assert.fail('must not reserve'));
  assert.equal(r.ok,false);assert.equal(calls,fault==='bid'?1:fault==='fee'?2:3);
 }
});
test('empty response or lost acknowledgement is resolved by exact-ID readback with no repeated PUT',async()=>{
 for(const lost of [false,true]){
  let calls=0,reservations=0,puts=0;
  const s=create(async(url,o)=>{calls++;if(calls===2)return preview();if(o.method==='PUT'){
    puts++;assert.equal(o.headers['x-csrf-token'],'private-fresh');assert.deepEqual(JSON.parse(o.body),{hasCancelFee:false,operation:'CANCEL'});
    assert.equal(reservations,1);if(lost)throw Error('private');return new Response(null,{status:204});
  }return page(calls>=5?{status:'cancelled'}:{});});
  const r=await s.cancelListingWithoutFee(id,{title,priceYen:99999,quantity:1},async()=>{reservations++});
  assert.equal(r.ok,true);assert.equal(r.value.status,'cancelled');assert.equal(JSON.stringify(r).includes('private'),false);
  assert.equal((await s.cancelListingWithoutFee(id,{},async()=>assert.fail())).code,'CANCELLATION_ALREADY_ATTEMPTED');assert.equal(puts,1);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationRequest, publicationResponseEvidence, PUBLICATION_URL } from './webHttpPublication.ts';
import { YahooWebSession } from './webHttpSession.ts';
const image={url:'https://auctions.c.yimg.jp/example.jpg',width:1200,height:1200};
const input={title:'Chair',description:'Good chair',condition:'used20',priceYen:99999,quantity:1,categoryId:'2084057261',
  closingDateJst:'2026-10-19',closingHourJst:11,shipping:{payer:'seller',method:'家財おまかせ便',prefecture:'11',schedule:'2'}};
const values={mode:'submit',comefrprv:'1',md5:'private-signature','.crumb':'fresh-private-token',Title:'Chair',Description:'Good chair',
  category:input.categoryId,Quantity:'1',istatus:'used20',salesmode:'buynow',StartPrice:'99999',BidOrBuyPrice:'99999',
  ImageFullPath1:image.url,ImageWidth1:'1200',ImageHeight1:'1200',shipping:'seller',shipname1:'家財おまかせ便',shipmethod:'other',
  loc_cd:'11',shipschedule:'2',ClosingYMD:'2026-10-19',ClosingTime:'11',numResubmit:'0',AutoExtension:'no',Offer:'0',
  featuredAmount:'',cpaAmount:'',totalCharges:'0',insertionFeeTotal:'0',is_paypay_fleamarket_cross_listing:'0',
  endDate:String(Date.parse('2026-10-19T02:30:00Z')/1000)};
const fields=o=>Object.entries(o).map(([k,v])=>`<input type="hidden" name="${k}" value="${v}">`).join('');
const preview=(change={})=>`<form name="auction" method="post">${fields({...values,...change})}</form><button id="auc_preview_submit_down" onclick="auc_submitpreview_disabled();configSubmit(document.auction, '${PUBLICATION_URL}', 'UTF-8');">出品する</button>`;
test('relisting requires the exact cancelled ID and observed mode, not a new-listing fallback',()=>{
 const relist={...input,relistId:'f1248612637'};
 const form=preview({mode:'oresubmit',aID:'f1248612637',Image1Uploaded:'1'});
 assert.equal(publicationRequest(form,relist,image).get('aID'),'f1248612637');
 assert.throws(()=>publicationRequest(form,input,image));
 assert.throws(()=>publicationRequest(form,{...relist,relistId:'f1248612638'},image));
 assert.throws(()=>publicationRequest(preview(),relist,image));
});
test('multiple images preserve order and reject omissions or substitution',()=>{
 const second={...image,url:'https://auctions.c.yimg.jp/second.jpg'};
 const form=preview({ImageFullPath2:second.url,ImageWidth2:'1200',ImageHeight2:'1200'});
 assert.equal(publicationRequest(form,input,[image,second]).get('ImageFullPath2'),second.url);
 assert.throws(()=>publicationRequest(form,input,[second,image]));
 assert.throws(()=>publicationRequest(form,input,image));
 assert.throws(()=>publicationRequest(preview(),input,[image,second]));
});
const inputForm=(category='0')=>`<form name="auction" method="post" action="https://auctions.yahoo.co.jp/sell/jp/show/preview">${fields({mode:'submit',aID:'',oldAID:'',category,'.crumb':'new',md5:'new',submitUnixtime:String(Date.parse('2026-10-16T03:00:00Z')/1000),Title:'',Description:'',loc_cd:'11',shipschedule:'2',salesmode:'buynow',BidOrBuyPrice:''})}<select name="istatus"><option value="used20">Good</option></select><select name="Quantity"><option value="1">1</option></select></form>`;
const selector=`<form name="topsubmit" method="post" action="https://auctions.yahoo.co.jp/sell/jp/show/submit">${fields({mode:'submit',aID:'',oldAID:'',category:'0',_crumb:'new',crumb:'new'})}</form>`;
const html=t=>new Response(t,{headers:{'content-type':'text/html'}});
function session(last) {
 let count=0;
 const s=YahooWebSession.fromStoredSession(JSON.stringify({schemaVersion:1,origin:'https://auctions.yahoo.co.jp',cookieHeader:'session=private',capturedAt:'2026-10-01T00:00:00Z',verifiedAt:'2026-10-01T00:00:00Z'}),{fetchImpl:async(url,opts)=>{
  count++;
  if(count===1)return html(inputForm()); if(count===2)return html(selector); if(count===3)return html(inputForm(input.categoryId)); if(count===4)return html(preview());
  assert.equal(url,PUBLICATION_URL);assert.equal(opts.redirect,'manual');assert.equal(opts.body.get('.crumb'),'fresh-private-token');return last();
 }}).value;
 return {s,count:()=>count};
}
test('publication rejects changed actions, unapproved options, unknown fields and mismatches',()=>{
 assert.equal(publicationRequest(preview(),input,image).get('BidOrBuyPrice'),'99999');
 for(const change of [{prereg:'1'},{unknownAdded:'1'},{totalCharges:'100'},{BidOrBuyPrice:'100'},{Quantity:'2'},{md5:''},{charityOption:'1'}])
  assert.throws(()=>publicationRequest(preview(change),input,image));
 assert.throws(()=>publicationRequest(preview().replace(PUBLICATION_URL,'https://evil.example/submit'),input,image));
});
test('an exact approval and durable reservation are required before one publication attempt',async()=>{
 const p=session(()=>html('<h1>出品が完了しました</h1><a href="https://auctions.yahoo.co.jp/jp/auction/x1234567890">商品</a>'));
 await p.s.previewFixedListing(input,image);
 assert.equal((await p.s.publishPreparedListing({title:'Other',priceYen:99999,quantity:1,termsAccepted:true},async()=>assert.fail())).code,'APPROVAL_MISMATCH');
 assert.equal(p.count(),4);let reserved=false;
 const r=await p.s.publishPreparedListing({title:'Chair',priceYen:99999,quantity:1,termsAccepted:true},async()=>{reserved=true});
 assert.equal(reserved,true);assert.equal(r.code,'PUBLICATION_READBACK_REQUIRED');assert.deepEqual(r.evidence.candidateAuctionIds,['x1234567890']);
 assert.equal(JSON.stringify(r).includes('private'),false);
 assert.equal((await p.s.publishPreparedListing({},async()=>assert.fail())).code,'PUBLICATION_ALREADY_ATTEMPTED');assert.equal(p.count(),5);
});
test('failed reservation and unknown network result are never automatically resent',async()=>{
 for(const failure of ['store','network']){
  const p=session(()=>{throw Error('private-secret')});await p.s.previewFixedListing(input,image);
  const r=await p.s.publishPreparedListing({title:'Chair',priceYen:99999,quantity:1,termsAccepted:true},async()=>{if(failure==='store')throw Error()});
  assert.equal(r.code,failure==='store'?'ATTEMPT_NOT_RESERVED':'PUBLICATION_RESULT_UNKNOWN');
  await p.s.publishPreparedListing({},async()=>assert.fail());assert.equal(p.count(),failure==='store'?4:5);
 }
});
test('result metadata ignores scripts, credentials and unrelated destinations',()=>{
 const r=publicationResponseEvidence('<script>出品しました private-secret</script><input value="secret"><a href="https://evil.example/jp/auction/x1234567890">a</a>');
 assert.deepEqual(r,{candidateAuctionIds:[],completionMessagePresent:false,loginRequired:false,errorPresent:false});
});

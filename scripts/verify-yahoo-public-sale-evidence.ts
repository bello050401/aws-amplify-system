import test from 'node:test';
import assert from 'node:assert/strict';
import {TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {parseYahooPublicSaleEvidence,readYahooPublicSaleEvidence} from '../lib/saleCandidates/yahooPublicSaleEvidence';
import {corroborateLinkedYahooSale} from '../lib/saleCandidates/yahooSaleFacts';
import {createYahooSaleFactCompleter} from '../lib/saleCandidates/yahooSaleFactsServer';
import {parseListingEvidence,canCancelWithoutBids} from '../lib/listing/yahooAuction/webHttpListing';
import {YahooWebSession} from '../lib/listing/yahooAuction/webHttpSession';
import {parsePurchaseMail} from '../lib/saleCandidates/mailParser';
import {mergeYahooNotification} from '../lib/saleCandidates/yahooMail';
import {automaticSaleDecision} from '../lib/saleCandidates/automationPolicy';
import {DEFAULT_FEES} from '../lib/saleCandidates/model';
const id='m1251432758',now=Date.now(),at=new Date(now).toISOString();
const item={auctionId:id,title:'Ritzwell '.repeat(12),price:25800,quantity:1,status:'closed',bids:1,biddersNum:1,highestBidders:{totalHighestBidders:1}};
const html=(change:Record<string,unknown>={})=>`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialState:{item:{detail:{item:{...item,...change}}}}}}})}</script>`;
const mail=(subject:string,authenticated=true,receivedAt=at)=>parsePurchaseMail({gmailId:'mail',from:'auction-master@mail.yahoo.co.jp',subject:subject+'：椅子('+id+')',receivedAt,authenticatedYahooSender:authenticated,text:'商品：椅子\nオークションID：'+id+'\n落札価格：25800 円\n残り数量：0'})[0];
const candidate=mail('即決価格での落札');
const ownership=()=>({inventoryId:'10000000-0000-4000-a000-000000000001',inventoryVersion:at,bindingCheckedAt:new Date().toISOString(),inventoryTable:'Inventory',quantity:4});
const proof=()=>parseYahooPublicSaleEvidence(html(),id)!;
test('long legacy public title produces explicitly public evidence, with no seller/write privileges',()=>{
 const p=proof();assert.equal(p.kind,'PUBLIC_LISTING');assert.equal('owned'in p,false);assert.equal(p.title,item.title);assert.equal(parseListingEvidence(html(),id),null);assert.equal(canCancelWithoutBids(p as any),false);
 const next=corroborateLinkedYahooSale(candidate,p,ownership())!;assert.equal(next.quantity,1);assert.equal(next.shipping,null);assert.equal(next.yahooSaleEvidence?.source,'TRUSTED_NOTICE_LINKED_CLOSED_LISTING');
});
test('only matching fresh closed one-unit winner proof + live binding + trusted seller WON yields sold quantity',()=>{
 for(const change of [{status:'open'},{status:'cancelled'},{quantity:2},{highestBidders:2},{highestBidders:0},{bids:0},{bidders:0},{priceYen:25801},{auctionId:'a1234567890'},{checkedAt:new Date(now-300001).toISOString()}])assert.equal(corroborateLinkedYahooSale(candidate,{...proof(),...change} as any,ownership(),now),null);
 for(const change of [{senderAuthenticated:false},{yahooAuthenticatedWonAt:undefined},{yahooAuthenticatedWonAt:'invalid'},{state:'DONE'},{identifierType:'ORDER'},{orderLineCount:2},{externalListingId:'a1234567890'}])assert.equal(corroborateLinkedYahooSale({...candidate,...change} as any,proof(),ownership(),now),null);
 assert.equal(corroborateLinkedYahooSale(candidate,proof(),{...ownership(),bindingCheckedAt:new Date(now-300001).toISOString()},now),null);
});
test('anonymous reader makes exactly one fixed GET, carries no cookies, and never follows redirects/challenges',async()=>{
 let calls=0;const p=await readYahooPublicSaleEvidence(id,{fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://auctions.yahoo.co.jp/jp/auction/'+id);assert.equal(options?.method,'GET');assert.equal(options?.redirect,'manual');assert.equal(options?.credentials,'omit');assert.deepEqual(options?.headers,{Accept:'text/html'});return new Response(html(),{headers:{'content-type':'text/html; charset=utf-8'}});}});assert.equal(p.kind,'PUBLIC_LISTING');assert.equal(calls,1);
 for(const status of [302,401,403,429,503]){let reads=0;await assert.rejects(readYahooPublicSaleEvidence(id,{fetchImpl:async()=>{reads++;return new Response(null,{status,headers:{location:'https://login.yahoo.co.jp/', 'content-type':'text/html'}});}}));assert.equal(reads,1);}
 await assert.rejects(readYahooPublicSaleEvidence('../other',{fetchImpl:async()=>assert.fail('invalid ID must not fetch')}));
});
test('public parser refuses duplicate scripts, wrong IDs, oversized titles/html, invalid counts and challenge pages',()=>{
 for(const body of [html()+html(),html({auctionId:'a1234567890'}),html({title:'x'.repeat(2001)}),html({quantity:0}),html({highestBidders:{totalHighestBidders:'1'}}),'<html>Verify you are human</html>','x'.repeat(2*1024*1024+1)])assert.equal(parseYahooPublicSaleEvidence(body,id),null);
});
test('existing cancel API still insists on its own owned read and never accepts the public proof for writes',async()=>{
 let reads=0;const opened=YahooWebSession.fromStoredSession(JSON.stringify({schemaVersion:1,origin:'https://auctions.yahoo.co.jp',cookieHeader:'fixture=value',capturedAt:at,verifiedAt:at}),{fetchImpl:async(_url,options)=>{reads++;assert.equal(options?.method,'GET');return new Response(html(),{headers:{'content-type':'text/html'}});}});assert(opened.ok);
 const result=await opened.value.cancelListingWithoutFee(id,proof(),async()=>assert.fail('public proof must not reach write reservation'));assert.equal(result.ok,false);assert.equal(reads,1);
});
test('fallback verifies live ownership before public read and atomically binds inventory + pending candidate versions',async()=>{
 const log:string[]=[];let saved:any;
 const complete=createYahooSaleFactCompleter(async()=>{throw Error('YAHOO_SALE_FORM_CHANGED');},{liveOwnership:async()=>{log.push('live-binding');return ownership();},readPublic:async()=>{log.push('public-read');return proof();}});
 const db={send:async(cmd:any)=>{assert(cmd instanceof TransactWriteCommand);const [check,put]=cmd.input.TransactItems!;assert.equal(check.ConditionCheck!.ExpressionAttributeValues![':v'],at);assert.equal(put.Put!.ExpressionAttributeValues![':v'],candidate.updatedAt);assert.equal(put.Put!.ConditionExpression,'#s=:pending AND updatedAt=:v');saved=put.Put!.Item;}} as any;
 const next=await complete(candidate,db,'Candidates');assert.deepEqual(log,['live-binding','public-read']);assert.equal(next.quantity,1);assert.equal(saved.yahooSaleEvidence.inventoryVersion,at);
});
test('unbound, denied, rate-limited, stale, or inventory/deletion races do not enrich a candidate',async()=>{
 let writes=0,publicReads=0;const db={send:async()=>{writes++;}} as any;
 for(const reason of ['YAHOO_SALE_ACCESS_DENIED','YAHOO_SALE_RATE_LIMITED'])await assert.rejects(createYahooSaleFactCompleter(async()=>{throw Error(reason);},{liveOwnership:async()=>assert.fail('must stop denied request'),readPublic:async()=>assert.fail('must not bypass denial')})(candidate,db,'Candidates'));
 const unbound=createYahooSaleFactCompleter(async()=>{throw Error('YAHOO_SALE_AUTH_REQUIRED');},{liveOwnership:async()=>null,readPublic:async()=>{publicReads++;return proof();}});assert.equal(await unbound(candidate,db,'Candidates'),candidate);assert.equal(publicReads,0);assert.equal(writes,0);
 for(const race of ['inventory','deletion']){
  let row={...candidate};const complete=createYahooSaleFactCompleter(async()=>{throw Error('YAHOO_SALE_FORM_CHANGED');},{liveOwnership:async()=>ownership(),readPublic:async()=>{if(race==='deletion')row={...row,state:'DELETED'};return proof();}});
  const racingDb={send:async(cmd:any)=>{assert(cmd instanceof TransactWriteCommand);assert.equal(cmd.input.TransactItems![0].ConditionCheck!.ExpressionAttributeValues![':v'],at);throw Object.assign(Error('conditional race'),{name:'TransactionCanceledException'});}} as any;
  await assert.rejects(complete(candidate,racingDb,'Candidates'),{name:'TransactionCanceledException'});assert.equal(row.quantity,null);
 }
});
test('spoofed WON plus authenticated later stage cannot establish WON provenance or evade the cutoff',()=>{
 const spoof=mail('即決価格での落札',false),address=mail('お届け先住所確定',true);const merged=mergeYahooNotification(spoof,address);assert.equal(merged.senderAuthenticated,true);assert.equal(merged.yahooAuthenticatedWonAt,undefined);assert.equal(corroborateLinkedYahooSale(merged,proof(),ownership()),null);
 const stock={id:ownership().inventoryId,quantity:4,updatedAt:at,name:'椅子'};const decision=automaticSaleDecision({...merged,quantity:1,verifiedSaleFacts:true},[stock.id],stock,DEFAULT_FEES,new Date(now-1000).toISOString());assert.notEqual(decision.kind,'SELL');
 const old=mail('即決価格での落札',true,new Date(now-10000).toISOString()),newTrusted=mail('即決価格での落札',true);const trusted=mergeYahooNotification(old,newTrusted);assert.equal(trusted.yahooAuthenticatedWonAt,old.yahooAuthenticatedWonAt);assert.equal((automaticSaleDecision({...trusted,quantity:1,verifiedSaleFacts:true},[stock.id],stock,DEFAULT_FEES,new Date(now-1000).toISOString()) as any).reason,'HISTORICAL');
});
test('reprocessing an authenticated WON enriches legacy provenance and preserves completed sale receipts',()=>{
 const legacy={...candidate,yahooAuthenticatedWonAt:undefined};const repaired=mergeYahooNotification(legacy,candidate);assert.equal(repaired.yahooAuthenticatedWonAt,candidate.yahooAuthenticatedWonAt);assert.equal(repaired.state,'PENDING');assert.equal(repaired.id,legacy.id);
 const receipt={sourceId:'source',soldId:'sold',soldQuantity:1,remainingQuantity:3,updatedAt:at};const completed=mergeYahooNotification({...legacy,state:'DONE',result:receipt},candidate);assert.equal(completed.state,'DONE');assert.equal(completed.result,receipt);assert.equal(completed.yahooAuthenticatedWonAt,candidate.yahooAuthenticatedWonAt);
});

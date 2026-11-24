import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanCommand} from '@aws-sdk/lib-dynamodb';
import {createRecordedMercariSaleGuard,hasRecordedMercariSale,recordedMercariOrders,MERCARI_RECORDED_SALE_REASON} from './recordedMercariSale';
import {createDesktopJobStore} from './desktopJobStore';
import {desktopJobId,newDesktopJob,type DesktopRequest} from './desktopJobModel';
import {runAutomaticSale,type AutomationJob,type AutomationPorts} from './automationCore';
import {DEFAULT_FEES,type SaleCandidate} from './model';
import {automaticSaleDecision} from './automationPolicy';
const now=Date.parse('2026-11-24T04:00:00Z'),at=new Date(now).toISOString();
const c:SaleCandidate={id:'a'.repeat(64),state:'PENDING',channel:'MERCARI',source:'GMAIL',senderAuthenticated:true,name:'Shared merchant title',quantity:1,unitPrice:24800,orderId:'order-1',identifierType:'ORDER',saleDate:'2026-11-24',receivedAt:at,createdAt:at,updatedAt:at,shipping:0,orderTotal:24800,payment:'',warnings:[],orderLineCount:1};
const sold={id:'a-different-sold-inventory',externalProductId:c.orderId,market:'メルカリSHOP',saleEndDate:'2026-11-23'};
test('legacy manual sale on another row blocks same order even without quantity/price/split provenance',()=>{
 const orders=recordedMercariOrders([sold]);assert.equal(hasRecordedMercariSale(c,orders),true);
 for(const row of [{...sold,market:'ヤフオク'},{...sold,externalProductId:'another-order'},{...sold,saleEndDate:''},{...sold,saleEndDate:undefined},{...sold,saleEndDate:'invalid'},{...sold,saleEndDate:'2026-02-31'}])assert.equal(hasRecordedMercariSale(c,recordedMercariOrders([row])),false);
 assert.equal(hasRecordedMercariSale({...c,channel:'BASE'},orders),false);assert.equal(hasRecordedMercariSale({...c,state:'DONE'},orders),false);
 assert.equal(hasRecordedMercariSale({...c,orderId:'order-1-other'},orders),false);
});
test('guard shares bounded authoritative initial/pre-mutation reads; never accepts partial/error scans as no collision',async()=>{
 let reads=0;const guard=createRecordedMercariSaleGuard({send:async command=>{assert(command instanceof ScanCommand);reads++;assert.equal(command.input.ConsistentRead,true);assert(!command.input.IndexName);return {Items:reads===1?[]:[sold]};}},'inventory');
 assert.equal(await guard(c),false);assert.equal(await guard({...c,orderId:'another-order'}),false);assert.equal(reads,1);
 assert.equal(await guard(c,true),true);assert.equal(await guard(c,true),true);assert.equal(reads,2);
 let pages=0;const incomplete=createRecordedMercariSaleGuard({send:async()=>{pages++;return {Items:[],LastEvaluatedKey:{id:'next-'+pages}};}},'inventory');
 await assert.rejects(()=>incomplete(c),/CHECK_UNAVAILABLE/);assert.equal(pages,30);await assert.rejects(()=>incomplete(c),/CHECK_UNAVAILABLE/);assert.equal(pages,30);
 const failed=createRecordedMercariSaleGuard({send:async()=>{throw Error('private database error');}},'inventory');await assert.rejects(()=>failed(c),/^Error: MERCARI_RECORDED_SALE_CHECK_UNAVAILABLE$/);
});
test('worker holds obsolete IDENTIFY receipt, leaves candidate/inventory untouched and cannot identify/sell/execute EC',async()=>{
 const request:DesktopRequest={purpose:'IDENTIFY_SALE',candidateId:c.id,inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',externalId:'ORDER:'+c.orderId,title:c.name,imageKeys:[],orderId:c.orderId,orderLineId:''};
 let row:Record<string,unknown>=newDesktopJob(request,now);
 const store=createDesktopJobStore({send:async command=>{
  if(command.constructor.name==='GetCommand')return {Item:structuredClone(row)};
  if(command.constructor.name==='PutCommand'){const put=command as import('@aws-sdk/lib-dynamodb').PutCommand;assert.equal(put.input.ExpressionAttributeValues?.[':v'],row.version);row=structuredClone(put.input.Item!);return {};}
  throw Error('Unexpected write');
 }},'jobs',()=>now);
 const guard=createRecordedMercariSaleGuard({send:async()=>({Items:[sold]})},'inventory');
 const job:AutomationJob={id:'AUTO:'+c.id,candidateId:c.id,state:'SALE_AUTO_ACTIVE',phase:'WAITING',reason:'MERCARI_DESKTOP_IDENTIFICATION',createdAt:at,updatedAt:at,receivedAt:at,version:'v1',attempts:0};
 let identifies=0,sells=0,ec=0;
 const p:AutomationPorts={now:()=>now,candidate:async()=>structuredClone(c),save:async()=>{},decide:async value=>{if(await guard(value)){await store.holdRecordedSale(desktopJobId(request));return {kind:'REVIEW',reason:MERCARI_RECORDED_SALE_REASON};}return automaticSaleDecision(value,[],null,DEFAULT_FEES,at);},identify:async()=>{identifies++;return {status:'WAIT'};},prepare:async()=>({status:'DONE'}),sell:async()=>{sells++;throw Error('Must not sell');},review:async()=>{ec++;throw Error('Must not review EC');},execute:async()=>{ec++;throw Error('Must not execute EC');}};
 await runAutomaticSale(job,p);assert.equal(job.state,'SALE_AUTO_ATTENTION');assert.equal(job.reason,MERCARI_RECORDED_SALE_REASON);assert.equal(row.state,'ATTENTION');assert.equal(row.reason,MERCARI_RECORDED_SALE_REASON);assert.equal(row.evidence,undefined);assert.equal((await p.candidate())?.state,'PENDING');assert.deepEqual({identifies,sells,ec},{identifies:0,sells:0,ec:0});
 const before=structuredClone(row);await store.holdRecordedSale(desktopJobId(request));assert.deepEqual(row,before);
});
test('manual sale appearing after decision is caught by shared pre-mutation read before stock/EC execution',async()=>{
 let reads=0,sells=0,ec=0;
 const candidate={...c,externalListingId:'mercari-1'},inventory={id:'source-inventory',quantity:5,updatedAt:at,name:c.name};
 const guard=createRecordedMercariSaleGuard({send:async()=>({Items:++reads===1?[]:[sold]})},'inventory');
 const job:AutomationJob={id:'AUTO:'+c.id,candidateId:c.id,state:'SALE_AUTO_ACTIVE',phase:'IDENTIFY',createdAt:at,updatedAt:at,receivedAt:at,version:'v1',attempts:0};
 await runAutomaticSale(job,{now:()=>now,candidate:async()=>candidate,save:async()=>{},decide:async value=>await guard(value)?{kind:'REVIEW',reason:MERCARI_RECORDED_SALE_REASON}:automaticSaleDecision(value,[inventory.id],inventory,DEFAULT_FEES,new Date(now-1000).toISOString()),prepare:async value=>await guard(value,true)?{status:'REVIEW',reason:MERCARI_RECORDED_SALE_REASON}:{status:'DONE'},sell:async()=>{sells++;throw Error('Must not sell');},review:async()=>{ec++;throw Error('Must not review EC');},execute:async()=>{ec++;throw Error('Must not execute EC');}});
 assert.equal(job.state,'SALE_AUTO_ATTENTION');assert.equal(job.reason,MERCARI_RECORDED_SALE_REASON);assert.deepEqual({reads,sells,ec},{reads:2,sells:0,ec:0});
});

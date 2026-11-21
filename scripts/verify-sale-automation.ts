import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {automaticSaleDecision} from '../lib/saleCandidates/automationPolicy';
import {runAutomaticSale,type AutomationJob,type AutomationPorts} from '../lib/saleCandidates/automationCore';
import {DEFAULT_FEES,type SaleCandidate} from '../lib/saleCandidates/model';
import {parsePurchaseMail} from '../lib/saleCandidates/mailParser';
import {redactInquiryContacts,redactInquiryRecord} from '../lib/messaging/contactPrivacy';
import {shouldSeedAutomation} from '../lib/saleCandidates/automationEligibility';
const id=randomUUID(),now='2026-11-08T13:00:00.000Z',cutoff='2026-11-08T12:00:00.000Z';
const c:SaleCandidate={id:'e'.repeat(64),state:'PENDING',channel:'BASE',source:'BASE_API',name:'木製チェア',quantity:2,unitPrice:10000,orderId:'TEST-ORDER',identifierType:'ORDER',saleDate:'2026-11-08',receivedAt:now,createdAt:now,updatedAt:now,shipping:1000,orderTotal:21000,payment:'creditcard',warnings:[],orderLineCount:1,externalListingId:'10000001',orderLineId:'10000002',orderRoute:'WEB',baseDispatchStatus:'ordered'};
const item={id,name:'【在庫5】木製チェア',quantity:5,updatedAt:now};
const decide=(change:Partial<SaleCandidate>={},stock=item,ids=[id])=>automaticSaleDecision({...c,...change},ids,stock,DEFAULT_FEES,cutoff);
test('exact ID, explicit quantity and paid/shippable BASE order produce existing stock request',()=>{const d=decide();assert.equal(d.kind,'SELL');if(d.kind==='SELL'){assert.equal(d.request.quantity,2);assert.equal(d.request.salePrice,20000);assert.equal(d.request.saleShippingReceived,1000);assert.equal(d.request.saleCommission,1426);}});
for(const [name,patch,reason] of [
 ['unpaid',{baseDispatchStatus:'unpaid'},'WAITING_PAYMENT'],['cancelled',{baseDispatchStatus:'cancelled'},'CANCELLED'],['COD',{payment:'cod'},'ORDER_REVIEW'],
 ['unknown quantity',{quantity:null},'QUANTITY_UNKNOWN'],['insufficient stock',{quantity:6},'STOCK_CHANGED'],['shipping missing',{shipping:null},'ORDER_REVIEW'],
 ['bundle',{name:'2脚セット'},'SET_REVIEW'],['unknown price',{unitPrice:null},'ORDER_REVIEW'],['variation',{warnings:['種類・バリエーションも確認してください。']},'ORDER_REVIEW'],
 ['old order',{receivedAt:'2026-11-01T00:00:00Z'},'HISTORICAL'],['no item id',{externalListingId:undefined},'NO_ITEM_ID'],
 ['spoofed mail',{channel:'MERCARI',source:'GMAIL',senderAuthenticated:false},'UNTRUSTED_MAIL'],
] as [string,Partial<SaleCandidate>,string][])test('no stock/EC writes: '+name,()=>{const d=decide(patch);assert.notEqual(d.kind,'SELL');assert.equal('reason'in d&&d.reason,reason);});
test('split stocks sharing listing ID never choose first hit',()=>assert.equal((decide({},item,[id,randomUUID()]) as any).reason,'NOT_UNIQUE'));
test('human completes notification before first worker poll: seed EC processing; exclude old sales/direct/invoice',()=>{
 const done:SaleCandidate={...c,state:'DONE',completedAt:now,result:{sourceId:id,soldId:id,remainingQuantity:0,soldQuantity:2,updatedAt:now}};
 assert.equal(shouldSeedAutomation(done,cutoff),true);
 assert.equal(shouldSeedAutomation({...done,completedAt:'2026-11-01T00:00:00Z'},cutoff),false);
 assert.equal(shouldSeedAutomation({...done,source:'DIRECT'},cutoff),false);
 assert.equal(shouldSeedAutomation({...done,source:'INVOICE'},cutoff),false);
 assert.equal(shouldSeedAutomation({...c,state:'DELETED'},cutoff),false);
});
test('Yahoo excludes shipping fee and keeps quantity/date deferred until authenticated payment',()=>{
 const y=parsePurchaseMail({gmailId:'qa',from:'auction-master@mail.yahoo.co.jp',subject:'即決価格での落札：木製チェア(r1240092475)',receivedAt:now,authenticatedYahooSender:true,text:'商品：木製チェア\nオークションID：r1240092475\n落札価格：10000 円\n落札数量：1\n送料：1000 円'})[0];
 const d=automaticSaleDecision(y,[id],item,DEFAULT_FEES,cutoff);assert.equal(d.kind,'SELL');if(d.kind==='SELL'){assert.equal(d.request.saleCommission,999);assert.equal(d.request.awaitingYahooPayment,true);assert.equal(d.request.saleEndDate,'');}
 const missing=parsePurchaseMail({gmailId:'qa2',from:'auction-master@mail.yahoo.co.jp',subject:'即決価格での落札：木製チェア(r1240092475)',receivedAt:now,authenticatedYahooSender:true,text:'商品：木製チェア\nオークションID：r1240092475\n落札価格：10000 円\n残り数量：0\n送料：0 円'})[0];
 assert.equal((automaticSaleDecision(missing,[id],item,DEFAULT_FEES,cutoff) as any).reason,'QUANTITY_UNKNOWN');
});
function flow(){
 let candidate=structuredClone(c),saleWrites=0,stopWrites=0;
 const job:AutomationJob={id:'AUTO:'+c.id,candidateId:c.id,state:'SALE_AUTO_ACTIVE',phase:'IDENTIFY',createdAt:now,updatedAt:now,receivedAt:now,version:'v',attempts:0};
 const plan:any={id:c.id,candidateId:c.id,sourceId:id,sourceVersion:now,soldChannel:'BASE',remaining:0,actor:'worker',expiresAt:Date.now()+60000,rows:[{channel:'YAHOO',operation:'STOP',state:'READY'}],state:'REVIEW',token:'t',updatedAt:now};
 const p:AutomationPorts={now:()=>Date.parse(now)+15000,candidate:async()=>candidate,decide:async()=>decide(),prepare:async()=>({status:'DONE'}),save:async()=>{},sell:async()=>{saleWrites++;const result={sourceId:id,soldId:id,remainingQuantity:0,soldQuantity:2,updatedAt:now};candidate={...candidate,state:'DONE',result};return result;},review:async()=>plan,execute:async p=>{stopWrites++;return {...p,state:'COMPLETE',rows:p.rows.map(r=>({...r,state:'DONE'}))};}};
 return {job,p,plan,setCandidate:(value:SaleCandidate)=>{candidate=value;},counts:()=>({saleWrites,stopWrites})};
}
test('notification → sale → stop; repeat does not write twice; measured elapsed retained',async()=>{const f=flow();await runAutomaticSale(f.job,f.p);await runAutomaticSale(f.job,f.p);assert.deepEqual(f.counts(),{saleWrites:1,stopWrites:1});assert.equal(f.job.elapsedMs,15000);assert.equal(f.job.state,'SALE_AUTO_COMPLETE');});
test('sale committed then network lost: retry checks DONE without decrement again',async()=>{const f=flow(),sell=f.p.sell;f.p.sell=async(...args)=>{await sell(...args);throw Error('response lost');};await assert.rejects(runAutomaticSale(f.job,f.p));f.p.sell=sell;await runAutomaticSale(f.job,f.p);assert.deepEqual(f.counts(),{saleWrites:1,stopWrites:1});});
test('stop failure is attention, not success',async()=>{const f=flow();f.p.execute=async p=>({...p,state:'ATTENTION',rows:p.rows.map(r=>({...r,state:'VERIFY_REQUIRED'}))});await runAutomaticSale(f.job,f.p);assert.equal(f.job.state,'SALE_AUTO_ATTENTION');assert.equal(f.job.reason,'EC_RESULT_UNCONFIRMED');});
test('sold channel / republish cannot pass automatic boundary',async()=>{const f=flow();f.plan.rows[0].channel='BASE';await runAutomaticSale(f.job,f.p);assert.equal(f.counts().stopWrites,0);assert.equal(f.job.reason,'SOLD_CHANNEL_PROTECTED');});
test('ambiguous match leaves stock and EC untouched',async()=>{const f=flow();f.p.decide=async()=>({kind:'REVIEW',reason:'NOT_UNIQUE'});await runAutomaticSale(f.job,f.p);assert.deepEqual(f.counts(),{saleWrites:0,stopWrites:0});});
test('required eConveni/desktop preflight never sells on missing or pending evidence',async()=>{
 for(const status of ['WAIT','REVIEW'] as const){const f=flow();f.p.prepare=async()=>({status,reason:'ECONVENI_BINDING_REQUIRED',nextAt:Date.parse(now)+6*3600000});await runAutomaticSale(f.job,f.p);assert.deepEqual(f.counts(),{saleWrites:0,stopWrites:0});assert.equal(f.job.state,status==='WAIT'?'SALE_AUTO_ACTIVE':'SALE_AUTO_ATTENTION');}
});
test('Mercari date notice is informational; discounts and unreconciled totals cannot mutate stock or EC',async()=>{
 const ordinary:SaleCandidate={...c,channel:'MERCARI',source:'GMAIL',senderAuthenticated:true,warnings:['販売終了日は通知受信日を初期表示しています。実際の販売日をご確認ください。']};
 assert.equal(decide(ordinary).kind,'SELL');
 for(const change of [{warnings:[...ordinary.warnings,'割引後の金額を確認してください。']},{warnings:['新しい金額形式を確認してください。']},{orderTotal:20000},{orderTotal:-1}]){
  const candidate={...ordinary,...change},f=flow();f.setCandidate(candidate);f.p.decide=async()=>decide(candidate);
  await runAutomaticSale(f.job,f.p);
  assert.equal(f.job.reason,'ORDER_REVIEW');assert.deepEqual(f.counts(),{saleWrites:0,stopWrites:0});
 }
});
test('Mercari missing listing ID waits for desktop identification then re-reads the resolved candidate',async()=>{
 const f=flow(),m:SaleCandidate={...c,channel:'MERCARI',source:'GMAIL',senderAuthenticated:true,externalListingId:undefined};f.setCandidate(m);
 f.p.decide=async value=>decide(value);let identifies=0;f.p.identify=async()=>{identifies++;f.setCandidate({...m,externalListingId:'mercari-item-id',updatedAt:'2026-11-08T13:01:00Z'});return {status:'DONE'};};
 await runAutomaticSale(f.job,f.p);assert.equal(identifies,1);assert.equal(f.counts().saleWrites,1);
 const waiting=flow();waiting.setCandidate(m);waiting.p.decide=async value=>decide(value);waiting.p.identify=async()=>({status:'WAIT',nextAt:Date.parse(now)+6*3600000});await runAutomaticSale(waiting.job,waiting.p);assert.equal(waiting.counts().saleWrites,0);assert.equal(waiting.job.reason,'MERCARI_DESKTOP_IDENTIFICATION');
});
test('CAS-enriched Yahoo facts refresh candidate version before transaction commit',async()=>{
 const f=flow(),enriched={...c,updatedAt:'2026-11-08T13:01:00Z'};let decisions=0;const sell=f.p.sell;
 f.p.decide=async()=>{decisions++;f.setCandidate(enriched);return decide();};f.p.sell=async(value,request)=>{assert.equal(value.updatedAt,enriched.updatedAt);return sell(value,request);};
 await runAutomaticSale(f.job,f.p);assert.equal(decisions,2);assert.equal(f.counts().saleWrites,1);
});
for(const [channel,operation] of [['YAHOO','RELIST'],['MERCARI_SHOPS','STOCK']] as const)test('remainder authorizes only requested sold-channel continuation: '+channel,async()=>{
 const f=flow();f.plan.soldChannel=channel;f.plan.remaining=3;f.plan.rows=[{channel,operation,state:'READY'}];await runAutomaticSale(f.job,f.p);assert.equal(f.counts().stopWrites,1);
 const zero=flow();zero.plan.soldChannel=channel;zero.plan.remaining=0;zero.plan.rows=[{channel,operation,state:'READY'}];await runAutomaticSale(zero.job,zero.p);assert.equal(zero.counts().stopWrites,0);
});
test('Yahoo reservation promptly executes other-channel actions while retaining WAITING_PAYMENT state',async()=>{
 const f=flow();f.setCandidate({...c,channel:'YAHOO',state:'DONE',result:{sourceId:id,soldId:id,remainingQuantity:0,soldQuantity:2,sourceQuantity:2,quantityDeferred:true,updatedAt:now}});
 await runAutomaticSale(f.job,f.p);assert.equal(f.counts().saleWrites,0);assert.equal(f.counts().stopWrites,1);assert.equal(f.job.reason,'WAITING_PAYMENT');assert.equal(f.job.state,'SALE_AUTO_ACTIVE');
});
test('unknown Yahoo shipping remains null and never becomes fake zero or part of the commission',()=>{
 const d=decide({channel:'YAHOO',source:'GMAIL',senderAuthenticated:true,verifiedSaleFacts:true,yahooStatus:'WON',yahooAuthenticatedWonAt:now,quantity:1,shipping:null,identifierType:'AUCTION',orderId:'r1240092475',externalListingId:'r1240092475'});assert.equal(d.kind,'SELL');if(d.kind==='SELL'){assert.equal(d.request.saleShippingReceived,null);assert.equal(d.request.saleCommission,999);}
});
test('30-second EC interval waits without retrying sale',async()=>{const f=flow();f.p.execute=async p=>({...p,nextAt:Date.parse(now)+45000});await runAutomaticSale(f.job,f.p);assert.equal(f.job.state,'SALE_AUTO_ACTIVE');assert.equal(f.job.nextAt,Date.parse(now)+45000);await runAutomaticSale(f.job,f.p);assert.equal(f.counts().saleWrites,1);});
test('privacy removes contact spans, preserves name, question, product URL and sizes',()=>{
 const t='山田です。東京都国立市東1-2-3です。\n電話：090-1234-5678\nmail: qa@example.invalid\n〒123-4567\n幅71.5cmの椅子はありますか？ https://bellointeri.base.shop/items/157908850';
 const r=redactInquiryContacts(t);for(const v of ['国立市','東1-2-3','090-1234','qa@example','123-4567'])assert.ok(!r.includes(v));for(const v of ['東京都','山田','71.5cm','157908850'])assert.ok(r.includes(v));assert.equal(redactInquiryContacts(r),r);
 assert.deepEqual(redactInquiryRecord({shippingAddress:'some street',phone:'123',quantity:2}),{shippingAddress:'[住所削除]',phone:'[連絡先削除]',quantity:2});
 assert.equal(redactInquiryContacts('福岡県糸島市に届けていただくことは可能でしょうか？'),'福岡県[住所削除]に届けていただくことは可能でしょうか？');
 assert.equal(redactInquiryContacts('東京都'),'東京都');
 assert.equal(redactInquiryContacts('配送先は目黒区です。送料はいくらですか？'),'配送先は[住所削除]です。送料はいくらですか？');
 assert.equal(redactInquiryContacts('札幌までですと送料はいくらですか？'),'[住所削除]までですと送料はいくらですか？');
 assert.equal(redactInquiryContacts('中村です。旭川家具はありますか？'),'中村です。旭川家具はありますか？');
 assert.equal(redactInquiryContacts('住所：群馬県前橋市\n三河町二丁目1-2-3\nサンプルマンション\n電話番号:090-1234-5678\n椅子はありますか？'),'住所：群馬県\n[住所削除]\n[住所削除]\n電話番号:[連絡先削除]\n椅子はありますか？');
 assert.equal(redactInquiryRecord({lastReadBy:'staff@example.invalid',digest:'08012345678'}).lastReadBy,'staff@example.invalid');
});

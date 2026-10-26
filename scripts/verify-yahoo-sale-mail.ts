import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GetCommand,PutCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {parsePurchaseMail,PURCHASE_QUERY,type PurchaseMail} from '../lib/saleCandidates/mailParser';
import {mergeYahooNotification} from '../lib/saleCandidates/yahooMail';
import {createCandidateStore} from '../lib/saleCandidates/storeCore';
import {importPurchases} from '../lib/saleCandidates/importer';
import type {SaleCandidate} from '../lib/saleCandidates/model';
import {collectYahooInventoryIds} from '../lib/saleCandidates/yahooListingMatch';
import type {EconveniWorkflow} from '../lib/listing/econveni/workflowStore';
import type {ManualSyncData} from '../lib/listing/econveni/manualSyncModel';

const id='r1240092475',title='確認用 チェア / プロ仕上げ';
const mail=(stage:'won'|'ended'|'address'|'paid',time?:string):PurchaseMail=>({gmailId:stage,from:'auction-master@mail.yahoo.co.jp',subject:'Yahoo!オークション - '+{won:'即決価格での落札',ended:'終了（落札者あり）',address:'お届け先住所確定',paid:'支払いが完了しました。商品を発送してください'}[stage]+'：'+title+'('+id+')',receivedAt:time||({won:'2026-10-26T11:03:22.000Z',ended:'2026-10-26T11:03:22.000Z',address:'2026-10-26T11:05:36.000Z',paid:'2026-10-26T11:25:06.000Z'}[stage]),text:'商品：'+title+'\nオークションID：'+id+'\nhttps://auctions.yahoo.co.jp/jp/auction/'+id+'?notice=clsic\n'+(stage==='won'?'開始価格：1 円\n残り数量：0\n落札価格：166,000 円\n':'')+'お届け先 PRIVATE-ADDRESS\n購入者 PRIVATE-CUSTOMER'});
const parse=(stage:Parameters<typeof mail>[0])=>parsePurchaseMail(mail(stage))[0];
const conditional=()=>Object.assign(Error('conditional'),{name:'ConditionalCheckFailedException'});
function memory(){
 const rows=new Map<string,any>();let beforePut:((key:string)=>void)|undefined;
 const db={send:async(cmd:any)=>{
  const i=cmd.input,key=i.Key?.id||i.Item?.id,v=i.ExpressionAttributeValues;
  if(cmd instanceof GetCommand)return {Item:structuredClone(rows.get(key))};
  if(cmd instanceof PutCommand){beforePut?.(key);const old=rows.get(key);if(i.ConditionExpression==='attribute_not_exists(id)'&&old||i.ConditionExpression?.includes('updatedAt=:version')&&(!old||old.updatedAt!==v[':version']||old.state!==v[':state']))throw conditional();rows.set(key,structuredClone(i.Item));return {};}
  if(cmd instanceof UpdateCommand){const old=rows.get(key);if(i.ConditionExpression.includes('expiresAt')&&old?.expiresAt>=v[':now']||i.ConditionExpression==='ownerId=:owner'&&old?.ownerId!==v[':owner'])throw conditional();rows.set(key,{...old,...(i.UpdateExpression.includes('ownerId')?{ownerId:v[':owner'],expiresAt:v[':expires']}:{expiresAt:0})});return {};}
  throw Error('UNEXPECTED_DB_ACTION');
 }} as unknown as DynamoDBDocumentClient;
 return {rows,db,beforePut(fn?:typeof beforePut){beforePut=fn;}};
}
test('four observed seller subjects share one auction candidate; remaining zero is not sale quantity',()=>{
 const c=['won','ended','address','paid'].map(s=>parse(s as any));assert.equal(new Set(c.map(x=>x.id)).size,1);assert.deepEqual(c.map(x=>x.yahooStatus),['WON','WON','ADDRESS_CONFIRMED','AWAITING_SHIPMENT']);assert.equal(c[0].unitPrice,166000);assert.equal(c[0].quantity,null);assert.equal(c[0].externalListingId,id);assert.equal(c[0].identifierType,'AUCTION');assert.ok(!JSON.stringify(c).includes('PRIVATE'));
});
test('sender and seller subjects strict; no-bid end/buyer/bidding/unrelated messages ignored',()=>{
 for(const m of [{...mail('won'),from:'auction-master@mail.yahoo.co.jp.evil.invalid'},{...mail('won'),from:'evil@example.invalid'},...['終了（落札者なし）','高値更新','あなたが落札しました','入札確認','Re: 即決価格での落札'].map(subject=>({...mail('won'),subject:subject+'：'+title+'('+id+')'}))])assert.deepEqual(parsePurchaseMail(m),[]);
});
test('ID from subject and link fallback; mismatches and missing IDs never get merged',()=>{
 assert.equal(parsePurchaseMail({...mail('paid'),text:''})[0].externalListingId,id);
 assert.equal(parsePurchaseMail({...mail('won'),subject:mail('won').subject.replace('('+id+')','')})[0].externalListingId,id);
 assert.deepEqual(parsePurchaseMail({...mail('won'),text:mail('won').text!.replace('オークションID：'+id,'オークションID：r1234567890')}),[]);
 assert.deepEqual(parsePurchaseMail({...mail('paid'),subject:mail('paid').subject.replace('('+id+')',''),text:'商品：確認用'}),[]);
});
test('HTML-only and explicit auction quantity, never start/payment price',()=>{
 const original=mail('won');const [c]=parsePurchaseMail({...original,text:undefined,html:original.text!.replace(/\n/g,'<br>')+'<br>落札数量：2個'});assert.equal(c.quantity,2);assert.equal(c.unitPrice,166000);
 const [paid]=parsePurchaseMail({...mail('paid'),text:mail('paid').text+'\n支払金額：180,000 円\n開始価格：1 円'});assert.equal(paid.unitPrice,null);
});
test('all 24 arrival orders yield one shipping-ready candidate retaining sale price and won date',()=>{
 function permutations<T>(a:T[]):T[][]{return a.length?a.flatMap((x,i)=>permutations(a.filter((_,j)=>i!==j)).map(p=>[x,...p])):[[]];}
 for(const order of permutations(['won','ended','address','paid'] as const)){
  const c=order.map(parse).reduce((current,next)=>mergeYahooNotification(current,next));assert.equal(c.yahooStatus,'AWAITING_SHIPMENT');assert.equal(c.unitPrice,166000);assert.equal(c.saleDate,'2026-10-26');assert.equal(c.yahooEvents?.WON,mail('won').receivedAt);assert.equal(Object.keys(c.yahooEvents||{}).length,3);assert.ok(!c.warnings.some(w=>w.includes('価格を取得できて')));
 }
});
test('late payment after midnight keeps original sale date; quoted won body cannot regress paid status',()=>{
 const paid=parsePurchaseMail({...mail('paid','2026-10-27T00:05:00.000Z'),text:mail('paid').text+'\n'+mail('won').text})[0];const c=mergeYahooNotification(paid,parse('won'));assert.equal(c.yahooStatus,'AWAITING_SHIPMENT');assert.equal(c.saleDate,'2026-10-26');assert.equal(c.receivedAt,'2026-10-27T00:05:00.000Z');
});
test('duplicate mail is a no-op and conflicting money is retained with a warning',()=>{
 const c=parse('won');assert.equal(mergeYahooNotification(c,c),c);const conflict=parsePurchaseMail({...mail('won'),text:mail('won').text!.replace('166,000','180,000')})[0];const merged=mergeYahooNotification(c,conflict);assert.equal(merged.unitPrice,166000);assert.ok(merged.warnings.some(w=>w.includes('異なる落札価格')));
});
test('updates cannot erase completed inventory result or resurrect a deleted candidate',()=>{
 const c={...parse('won'),state:'DONE',result:{soldId:'sold',sourceId:'source'},completedBy:'admin',completedAt:'2026-10-26T11:04:00.000Z'} as SaleCandidate;
 const next=mergeYahooNotification(c,parse('paid'));assert.equal(next.state,'DONE');assert.deepEqual(next.result,c.result);assert.equal(next.completedAt,c.completedAt);assert.equal(next.yahooStatus,'AWAITING_SHIPMENT');
 const deleted={...c,state:'DELETED'} as SaleCandidate;assert.equal(mergeYahooNotification(deleted,parse('paid')),deleted);
});
test('CAS retries after simultaneous sale and preserves its result',async()=>{
 const m=memory(),store=createCandidateStore(m.db,'T'),c=parse('won');await store.put(c);let once=true;m.beforePut(key=>{if(key===c.id&&once){once=false;m.rows.set(key,{...m.rows.get(key),state:'DONE',updatedAt:'2099-01-01T00:00:00.000Z',result:{soldId:'saved'},completedBy:'admin'});}});
 assert.equal(await store.receiveYahoo(parse('paid')),'updated');const result=await store.get(c.id);assert.equal(result?.state,'DONE');assert.equal(result?.result?.soldId,'saved');assert.equal(result?.yahooStatus,'AWAITING_SHIPMENT');
});
test('CAS retries after simultaneous deletion and cannot restore it',async()=>{
 const m=memory(),store=createCandidateStore(m.db,'T'),c=parse('won');await store.put(c);let once=true;m.beforePut(key=>{if(key===c.id&&once){once=false;m.rows.set(key,{...m.rows.get(key),state:'DELETED',updatedAt:'2099-01-01T00:00:00.000Z'});}});assert.equal(await store.receiveYahoo(parse('paid')),'unchanged');assert.equal((await store.get(c.id))?.state,'DELETED');
});
test('CAS exhaustion throws and leaves the failed email unacknowledged for retry',async()=>{
 const m=memory(),c=parse('won');m.rows.set(c.id,c);m.beforePut(key=>{if(key===c.id)m.rows.get(key).updatedAt=new Date(Date.parse(m.rows.get(key).updatedAt)+1).toISOString();});const reader=async()=>({list:async()=>({messages:[{id:'paid'}]}),read:async()=>mail('paid')});assert.equal((await importPurchases(m.db,'T',reader)).ok,false);assert.ok(!m.rows.has('MAIL:paid'));assert.deepEqual(m.rows.get('IMPORT_STATUS').pendingIds,['paid']);
 m.beforePut();m.rows.get('IMPORT_STATUS').lastAttemptAt='2000-01-01';assert.equal((await importPurchases(m.db,'T',reader)).ok,true);assert.equal(m.rows.get(c.id).yahooStatus,'AWAITING_SHIPMENT');assert.ok(m.rows.has('MAIL:paid'));
});
test('realistic newest-first importer dedupes four mails and re-read; only candidate table touched',async()=>{
 const m=memory();let reads=0;const reader=async()=>({list:async()=>({messages:['paid','address','ended','won'].map(id=>({id}))}),read:async(id:string)=>{reads++;return mail(id as any);}});
 const r=await importPurchases(m.db,'T',reader);assert.equal(r.created,1);const candidates=[...m.rows.values()].filter(x=>x.channel);assert.equal(candidates.length,1);assert.equal(candidates[0].unitPrice,166000);assert.equal(candidates[0].yahooStatus,'AWAITING_SHIPMENT');assert.equal(candidates[0].state,'PENDING');m.rows.get('IMPORT_STATUS').lastAttemptAt='2000-01-01';await importPurchases(m.db,'T',reader);assert.equal(reads,4);
});
test('old resumable query is discarded when Yahoo support is enabled',async()=>{
 const m=memory();m.rows.set('IMPORT_STATUS',{lastAttemptAt:'2000-01-01',scanQuery:'old mercari only query',pendingIds:['old'],nextPage:'oldpage'});let query='';const reader=async()=>({list:async(q:string,page?:string)=>{query=q;assert.equal(page,undefined);return {messages:[]};},read:async()=>{throw Error('OLD_CURSOR');}});assert.equal((await importPurchases(m.db,'T',reader)).ok,true);assert.ok(query.includes('auction-master@mail.yahoo.co.jp'));assert.ok(PURCHASE_QUERY.includes('subject:お届け先住所確定'));
});
test('ID lookup covers legacy Yahoo, e-conveni publish and explicit manual links; never title-only guesses',()=>{
 const workflow={inventoryId:'new',channels:{YAHOO:{listingId:id}}} as EconveniWorkflow;
 const manual={snapshot:{products:[{productId:'p1',title,channels:{YAHOO:{listingId:id}}},{productId:'unlinked',title,channels:{YAHOO:{listingId:id}}}]},links:[{inventoryId:'manual',productId:'p1',baseline:{YAHOO:{listingId:'old-id'}}},{inventoryId:'disabled',productId:'p2',baseline:{YAHOO:{listingId:id}},disabled:true}]} as ManualSyncData;
 assert.deepEqual(collectYahooInventoryIds(id,[{inventoryId:'legacy',auctionId:id},{inventoryId:'gone',auctionId:id,deletedAt:'2026-10-26'}],[workflow],manual),['legacy','new','manual']);
 assert.deepEqual(collectYahooInventoryIds(id,[{inventoryId:'new',auctionId:id}],[workflow],{snapshot:null,links:[]}),['new']);
 assert.deepEqual(collectYahooInventoryIds('r1234567890',[],[workflow],manual),[]);
});

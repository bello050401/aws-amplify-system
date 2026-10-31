// Opt-in integration test. Creates only uniquely named scratch DynamoDB tables;
// neither production inventory nor any EC/ZAICO endpoint is used.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,GetCommand,UpdateCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {createSoldOutService} from '../../lib/inventory/soldOutCore';
import {createCandidateStore} from '../../lib/saleCandidates/storeCore';
import {parsePurchaseMail} from '../../lib/saleCandidates/mailParser';
import {createYahooPaymentReconciler} from '../../lib/saleCandidates/yahooPaymentReconciler';
import {yahooPaymentKey,yahooPaymentPlan,YAHOO_PAYMENT_QUEUE_STATE} from '../../lib/saleCandidates/yahooPaymentModel';
import {yahooSenderAuthenticated} from '../../lib/saleCandidates/mailAuthentication';
import {summarizeSales} from '../../lib/inventory/sales';
import {writeFileSync,mkdirSync} from 'node:fs';
import type {SoldOutRequest} from '../../lib/inventory/soldOutInput';
import type {SaleCandidate} from '../../lib/saleCandidates/model';

async function main(){
 if(process.env.BELLO_PAYMENT_SCRATCH_TEST!=='1')throw Error('Explicit scratch-test opt-in required');
 const raw=new DynamoDBClient({region:'us-west-2'}),db=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}});
 const prefix='Bello-QA-YahooPayment-'+Date.now()+'-',created:string[]=[],passed:string[]=[];
 const table=(name:string)=>prefix+name,ct=table('Candidates');
 const store=createCandidateStore(db,ct),reconciler=createYahooPaymentReconciler(db,ct,table);
 const get=async(t:string,id:string)=>(await db.send(new GetCommand({TableName:table(t),Key:{id},ConsistentRead:true}))).Item;
 const put=async(t:string,item:Record<string,unknown>)=>db.send(new PutCommand({TableName:table(t),Item:item}));
 const check=(name:string)=>{passed.push(name);console.log('PASS',name);};
 const mail=(auction:string,paid=false,authenticated=true)=>({gmailId:randomUUID(),from:'auction-master@mail.yahoo.co.jp',subject:`Yahoo!オークション - ${paid?'支払いが完了しました。商品を発送してください':'即決価格での落札'}：QA確認用(${auction})`,receivedAt:paid?'2026-10-31T15:01:00.000Z':'2026-10-31T02:00:00.000Z',authenticatedYahooSender:authenticated,text:`商品：QA確認用\nオークションID：${auction}\n落札価格：10000 円\n落札数量：1`});
 async function fixture(available=5,sold=2,paid=false){
  const id=randomUUID(),auction='r'+String(Math.floor(Math.random()*9e10)+1e10),c=parsePurchaseMail(mail(auction,paid))[0];
  if(paid)c.unitPrice=10000;
  await store.put(c);
  const source={id,name:'【在庫'+available+'】QAチェア',quantity:available,updatedAt:'2026-10-30T00:00:00.000Z',createdAt:'2026-01-01T00:00:00.000Z',categoryId:'active',categoryIds:['active','other'],market:'ヤフオク',externalProductId:auction,salePrice:10000,images:[],customFields:'{}',listingPartition:'ACTIVE'};
  await put('Inventory',source);
  const request:SoldOutRequest={inventoryId:id,expectedUpdatedAt:source.updatedAt,mutationId:randomUUID(),sourceCandidateId:c.id,quantity:sold,name:source.name,market:'ヤフオク',externalProductId:auction,salePrice:10000,saleCommission:1000,saleEndDate:'2099-01-01'};
  const ports=(client=db,candidate=c)=>({db:client,table,categories:async()=>[{id:'active',name:'販売中'},{id:'sold',name:'売り切れ'},{id:'unpaid',name:'入金待ち'},{id:'other',name:'椅子'}],yahooPayment:yahooPaymentPlan(candidate),nextSku:async()=>randomUUID(),copyPhotos:async()=>[],discardPhotos:async()=>{},saleCommit:(result:any,now:string)=>createCandidateStore(client,ct).commit(candidate,'qa',result,now)});
  return {id,auction,c,source,request,ports,run:createSoldOutService(ports())};
 }
 const pay=async(f:Awaited<ReturnType<typeof fixture>>,authenticated=true)=>store.receiveYahoo(parsePurchaseMail(mail(f.auction,true,authenticated))[0]);
 const injected=(mode:'before'|'after')=>({send:async(cmd:any)=>{if(cmd instanceof TransactWriteCommand&&mode==='before')throw Error('fixture failure');const r=await db.send(cmd);if(cmd instanceof TransactWriteCommand&&mode==='after')throw Error('fixture lost response');return r;}} as unknown as typeof db);
 try{
  for(const model of ['Candidates','Inventory','Category','InventoryCategory','InventoryHistory']){
   const name=table(model);await raw.send(new CreateTableCommand({TableName:name,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'id',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'},...(model==='Candidates'?[{AttributeName:'state',AttributeType:'S' as const},{AttributeName:'receivedAt',AttributeType:'S' as const}]:[])],...(model==='Candidates'?{GlobalSecondaryIndexes:[{IndexName:'ByState',KeySchema:[{AttributeName:'state',KeyType:'HASH'},{AttributeName:'receivedAt',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}:{})}));created.push(name);
  }
  await Promise.all(created.map(TableName=>waitUntilTableExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName})));
  for(const [id,name] of [['active','販売中'],['sold','売り切れ'],['unpaid','入金待ち'],['other','椅子']])await put('Category',{id,name});
  for(let i=0;i<3;i++)assert.deepEqual(await reconciler.run(),{checked:0,applied:0,errors:0,more:false});
  assert.equal((await get('Candidates','YAHOO_PAYMENT_CURSOR'))!.cursor,null);
  check('repeated empty scheduled runs resume safely from persisted null cursor');
  for(const [available,sold] of [[1,1],[5,2],[5,5],[10,1]]){
   const f=await fixture(available,sold),r=await f.run(f.request,'qa'),stock=await get('Inventory',r.soldId);
   assert.equal(stock!.quantity,sold);assert.equal(stock!.saleEndDate,null);assert.deepEqual(stock!.categoryIds,['other','sold','unpaid']);
   const original=await get('Inventory',f.id);if(sold<available){assert.equal(original!.quantity,available-sold);assert.deepEqual(original!.categoryIds,f.source.categoryIds);}
   const queue=await get('Candidates',yahooPaymentKey(f.c.id));assert.equal(queue!.soldId,r.soldId);assert.equal(queue!.state,YAHOO_PAYMENT_QUEUE_STATE);
   assert.equal((await store.get(f.c.id))!.yahooPaymentState,'WAITING');assert.equal(summarizeSales([stock as any],2026,10).count,0);
   assert.equal(await reconciler.settle(queue as any),'waiting');
   // Repeated sale request does not deduct stock again.
   assert.deepEqual(await f.run(f.request,'qa'),r);
   await pay(f,false);assert.equal(await reconciler.settle(queue as any),'waiting');
   await pay(f);assert.equal(await reconciler.settle(queue as any),'applied');
   const paidStock=await get('Inventory',r.soldId);assert.equal(paidStock!.saleEndDate,'2026-11-01');assert.deepEqual(paidStock!.categoryIds,['other','sold']);assert.equal(paidStock!.quantity,sold);
   for(const k of ['name','salePrice','saleCommission','images','externalProductId'])assert.deepEqual(paidStock![k],stock![k]);
   if(sold<available)assert.deepEqual(await get('Inventory',f.id),original);
   assert.equal(await get('InventoryCategory',r.soldId+':unpaid'),undefined);assert.ok(await get('InventoryCategory',r.soldId+':sold'));
   assert.equal(await get('Candidates',queue!.id),undefined);assert.equal((await store.get(f.c.id))!.yahooPaymentState,'APPLIED');
   assert.equal(summarizeSales([paidStock as any],2026,11).count,1);
   await pay(f);assert.equal(await reconciler.settle(queue as any),'skipped');assert.deepEqual(await get('Inventory',r.soldId),paidStock);
   check(`${available}→${sold}: unpaid, one split, payment JST date, revenue, duplicate mail, remainder unchanged`);
  }
  {const f=await fixture(5,2,true),r=await f.run(f.request,'qa'),row=await get('Inventory',r.soldId);assert.equal(row!.saleEndDate,'2026-11-01');assert.deepEqual(row!.categoryIds,['other','sold']);assert.equal(await get('Candidates',yahooPaymentKey(f.c.id)),undefined);check('payment before sale uses payment date immediately');}
  {const f=await fixture();await assert.rejects(createSoldOutService({...f.ports(),yahooPayment:undefined})({...f.request,awaitingYahooPayment:true,saleEndDate:''},'qa'));assert.deepEqual(await get('Inventory',f.id),f.source);check('forged unpaid UI flag cannot authorize date omission');}
  {const f=await fixture();await assert.rejects(createSoldOutService(f.ports(injected('before')))(f.request,'qa'));assert.deepEqual(await get('Inventory',f.id),f.source);assert.equal(await get('Candidates',yahooPaymentKey(f.c.id)),undefined);assert.equal((await store.get(f.c.id))!.state,'PENDING');check('failed sale changes neither source, candidate nor payment queue');}
  {const f=await fixture();await pay(f);await assert.rejects(f.run(f.request,'qa'));assert.deepEqual(await get('Inventory',f.id),f.source);assert.equal(await get('Candidates',yahooPaymentKey(f.c.id)),undefined);check('mail concurrent with sale safely forces fresh confirmation');}
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id)),before=await get('Inventory',r.soldId);await pay(f);await assert.rejects(createYahooPaymentReconciler(injected('before'),ct,table).settle(q as any));assert.deepEqual(await get('Inventory',r.soldId),before);assert.equal((await store.get(f.c.id))!.yahooPaymentState,'WAITING');await reconciler.settle(q as any);check('failed payment transaction is atomic and safely retryable');}
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);await assert.rejects(createYahooPaymentReconciler(injected('after'),ct,table).settle(q as any));assert.equal(await reconciler.settle(q as any),'skipped');assert.equal((await get('Inventory',r.soldId))!.quantity,2);check('lost payment response never repeats quantity or history changes');}
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);const outcomes=await Promise.allSettled([reconciler.settle(q as any),reconciler.settle(q as any)]);assert.ok(outcomes.some(x=>x.status==='fulfilled'));assert.equal((await get('Inventory',r.soldId))!.saleEndDate,'2026-11-01');assert.equal((await get('Inventory',f.id))!.quantity,3);check('simultaneous payment workers commit once');}
  for(const change of [{saleEndDate:'2026-10-30'},{quantity:1},{externalProductId:'r99999999999'},{deletedAt:'2026-10-31'},{categoryIds:['active','sold','unpaid']},{outboundBatchId:'reserved'}]){
   const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);const modified={...await get('Inventory',r.soldId),...change};await put('Inventory',modified);await assert.rejects(reconciler.settle(q as any));assert.deepEqual(await get('Inventory',r.soldId),modified);
  }check('manual date, quantity, order change, deletion, resale and outbound reservation protected');
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);await assert.rejects(reconciler.settle({...q,soldId:f.id} as any));assert.equal((await get('Inventory',r.soldId))!.saleEndDate,null);check('queue substitution cannot update remaining inventory');}
  assert.equal(yahooSenderAuthenticated([{name:'Authentication-Results',value:'mx.google.com; dmarc=pass (p=REJECT) header.from=mail.yahoo.co.jp;'}]),true);
  for(const value of ['evil.invalid; dmarc=pass header.from=mail.yahoo.co.jp;','mx.google.com; dmarc=fail header.from=mail.yahoo.co.jp;','mx.google.com; dmarc=pass header.from=mail.yahoo.co.jp.evil.invalid;'])assert.equal(yahooSenderAuthenticated([{name:'Authentication-Results',value}]),false);
  check('only Google-received aligned Yahoo authentication can mark paid');
  const run=await reconciler.run();assert.ok(run.errors>=6);
  const again=await reconciler.run();assert.ok(again.errors>=6);assert.equal(again.applied,0);
  check('scheduled query retries and records visible conflict errors across repeated runs');
 }finally{
  for(const TableName of created){assert.ok(TableName.startsWith(prefix));await raw.send(new DeleteTableCommand({TableName}));}
  mkdirSync('artifacts/yahoo-payment-20261031',{recursive:true});writeFileSync('artifacts/yahoo-payment-20261031/aws-scratch-tests.json',JSON.stringify({checkedAt:new Date().toISOString(),passed,scratchTables:created,cleanup:'DELETE requested for all scratch tables'},null,2));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

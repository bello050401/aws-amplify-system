// Opt-in integration test. Creates only uniquely named scratch DynamoDB tables;
// neither production inventory nor any EC/ZAICO endpoint is used.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists,waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
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
 let copies=0,skuCalls=0,copyFailure=false;
 const stockPorts={categories:async()=>[{id:'active',name:'販売中'},{id:'sold',name:'売り切れ'},{id:'unpaid',name:'入金待ち'},{id:'other',name:'椅子'}],nextSku:async()=>{skuCalls++;return randomUUID();},copyPhotos:async()=>{copies++;if(copyFailure)throw Error('copy failure');return [{storageKey:'inventory/qa-'+randomUUID()+'.jpg',type:'NORMAL'}];},discardPhotos:async()=>{}};
 const store=createCandidateStore(db,ct),reconciler=createYahooPaymentReconciler(db,ct,table,stockPorts);
 const get=async(t:string,id:string)=>(await db.send(new GetCommand({TableName:table(t),Key:{id},ConsistentRead:true}))).Item;
 const put=async(t:string,item:Record<string,unknown>)=>db.send(new PutCommand({TableName:table(t),Item:item}));
 const check=(name:string)=>{passed.push(name);console.log('PASS',name);};
 const mail=(auction:string,paid=false,authenticated=true)=>({gmailId:randomUUID(),from:'auction-master@mail.yahoo.co.jp',subject:`Yahoo!オークション - ${paid?'支払いが完了しました。商品を発送してください':'即決価格での落札'}：QA確認用(${auction})`,receivedAt:paid?'2026-10-31T15:01:00.000Z':'2026-10-31T02:00:00.000Z',authenticatedYahooSender:authenticated,text:`商品：QA確認用\nオークションID：${auction}\n落札価格：10000 円\n落札数量：1`});
 async function fixture(available=5,sold=2,paid=false){
  const id=randomUUID(),auction='r'+String(Math.floor(Math.random()*9e10)+1e10),c=parsePurchaseMail(mail(auction,paid))[0];
  if(paid)c.unitPrice=10000;
  await store.put(c);
  const source={id,name:'【在庫'+available+'】QAチェア',quantity:available,updatedAt:'2026-10-30T00:00:00.000Z',createdAt:'2026-01-01T00:00:00.000Z',categoryId:'active',categoryIds:['active','other'],market:'ヤフオク',externalProductId:auction,salePrice:10000,images:[{storageKey:'inventory/original.jpg',type:'NORMAL'}],note:'original',customFields:'{}',listingPartition:'ACTIVE'};
  await put('Inventory',source);
  const request:SoldOutRequest={inventoryId:id,expectedUpdatedAt:source.updatedAt,mutationId:randomUUID(),sourceCandidateId:c.id,quantity:sold,name:source.name+'売却分',market:'ヤフオク',externalProductId:auction,salePrice:10000,saleCommission:1000,saleEndDate:'2099-01-01'};
  const ports=(client=db,candidate=c)=>({db:client,table,yahooPayment:yahooPaymentPlan(candidate),...stockPorts,saleCommit:(result:any,now:string)=>createCandidateStore(client,ct).commit(candidate,'qa',result,now)});
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
   const f=await fixture(available,sold),beforeCopies=copies,beforeSku=skuCalls,r=await f.run(f.request,'qa'),stock=await get('Inventory',f.id);
   assert.equal(r.soldId,f.id);assert.equal(r.quantityDeferred,true);assert.equal(stock!.quantity,available);assert.equal(stock!.saleEndDate,null);assert.equal(stock!.name,f.source.name);assert.deepEqual(stock!.images,f.source.images);assert.equal(copies,beforeCopies);assert.equal(skuCalls,beforeSku);
   assert.deepEqual(stock!.categoryIds,sold<available?['active','other','unpaid']:['other','sold','unpaid']);
   const queue=await get('Candidates',yahooPaymentKey(f.c.id));assert.equal(queue!.quantityDeferred,true);assert.equal(queue!.state,YAHOO_PAYMENT_QUEUE_STATE);
   assert.equal((await store.get(f.c.id))!.yahooPaymentState,'WAITING');assert.equal(summarizeSales([stock as any],2026,10).count,0);assert.equal(await reconciler.settle(queue as any),'waiting');assert.deepEqual(await f.run(f.request,'qa'),r);
   await pay(f,false);assert.equal(await reconciler.settle(queue as any),'waiting');assert.equal((await get('Inventory',f.id))!.quantity,available);
   await pay(f);assert.equal(await reconciler.settle(queue as any),'applied');
   const final=(await store.get(f.c.id))!,paidStock=await get('Inventory',final.result!.soldId),original=await get('Inventory',f.id);
   assert.equal(final.result!.quantityDeferred,undefined);assert.equal(final.saleDate,'2026-11-01');assert.equal(paidStock!.saleEndDate,'2026-11-01');assert.equal(JSON.parse(paidStock!.customFields).__belloYahooPayment.paidAt,'2026-10-31T15:01:00.000Z');assert.deepEqual(paidStock!.categoryIds,['other','sold']);assert.equal(paidStock!.quantity,sold);assert.equal(paidStock!.name,'【在庫'+sold+'】QAチェア売却分');assert.equal(paidStock!.salePrice,10000);assert.equal(paidStock!.saleCommission,1000);
   if(sold<available){assert.notEqual(final.result!.soldId,f.id);assert.equal(original!.quantity,available-sold);assert.equal(original!.name,'【在庫'+(available-sold)+'】QAチェア');assert.deepEqual(original!.categoryIds,f.source.categoryIds);assert.equal(JSON.parse(original!.customFields).__belloYahooPayment,undefined);assert.deepEqual(original!.images,f.source.images);assert.notEqual(paidStock!.images[0].storageKey,f.source.images[0].storageKey);assert.equal(copies,beforeCopies+1);}
   else {assert.equal(final.result!.soldId,f.id);assert.equal(original!.quantity,available);assert.equal(copies,beforeCopies);}
   assert.equal(await get('Candidates',queue!.id),undefined);assert.equal(final.yahooPaymentState,'APPLIED');assert.equal(summarizeSales([paidStock as any],2026,11).count,1);
   await pay(f);await store.receiveYahoo(parsePurchaseMail(mail(f.auction))[0]);assert.equal(await reconciler.settle(queue as any),'skipped');assert.deepEqual(await get('Inventory',final.result!.soldId),paidStock);assert.deepEqual(await get('Inventory',f.id),original);
   check(available+'/'+sold+': stock/title/photos unchanged pending; atomic split on paid date; revenue; duplicate/out-of-order notices');
  }
  {const f=await fixture(5,2,true),r=await f.run(f.request,'qa'),row=await get('Inventory',r.soldId);assert.equal(row!.saleEndDate,'2026-11-01');assert.deepEqual(row!.categoryIds,['other','sold']);assert.equal(await get('Candidates',yahooPaymentKey(f.c.id)),undefined);check('payment before sale uses payment date immediately');}
  {const f=await fixture();await assert.rejects(createSoldOutService({...f.ports(),yahooPayment:undefined})({...f.request,awaitingYahooPayment:true,saleEndDate:''},'qa'));assert.deepEqual(await get('Inventory',f.id),f.source);check('forged unpaid UI flag cannot authorize date omission');}
  {const f=await fixture();await assert.rejects(createSoldOutService(f.ports(injected('before')))(f.request,'qa'));assert.deepEqual(await get('Inventory',f.id),f.source);assert.equal(await get('Candidates',yahooPaymentKey(f.c.id)),undefined);assert.equal((await store.get(f.c.id))!.state,'PENDING');check('failed sale changes neither source, candidate nor payment queue');}
  {const f=await fixture();await pay(f);await assert.rejects(f.run(f.request,'qa'));assert.deepEqual(await get('Inventory',f.id),f.source);assert.equal(await get('Candidates',yahooPaymentKey(f.c.id)),undefined);check('mail concurrent with sale safely forces fresh confirmation');}
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id)),before=await get('Inventory',r.soldId);await pay(f);await assert.rejects(createYahooPaymentReconciler(injected('before'),ct,table,stockPorts).settle(q as any));assert.deepEqual(await get('Inventory',r.soldId),before);assert.equal((await store.get(f.c.id))!.yahooPaymentState,'WAITING');await reconciler.settle(q as any);check('failed payment transaction is atomic and safely retryable');}
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);assert.equal(await createYahooPaymentReconciler(injected('after'),ct,table,stockPorts).settle(q as any),'applied');assert.equal(await reconciler.settle(q as any),'skipped');assert.equal((await get('Inventory',f.id))!.quantity,3);check('lost payment response never repeats quantity or history changes');}
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);const outcomes=await Promise.allSettled([reconciler.settle(q as any),reconciler.settle(q as any)]);assert.ok(outcomes.some(x=>x.status==='fulfilled'));assert.equal((await get('Inventory',(await store.get(f.c.id))!.result!.soldId))!.saleEndDate,'2026-11-01');assert.equal((await get('Inventory',f.id))!.quantity,3);check('simultaneous payment workers commit once');}
  for(const change of [{saleEndDate:'2026-10-30'},{quantity:1},{externalProductId:'r99999999999'},{deletedAt:'2026-10-31'},{categoryIds:['active','sold','unpaid']},{outboundBatchId:'reserved'}]){
   const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);const modified={...await get('Inventory',r.soldId),...change};await put('Inventory',modified);await assert.rejects(reconciler.settle(q as any));assert.deepEqual(await get('Inventory',r.soldId),modified);
  }check('manual date, quantity, order change, deletion, resale and outbound reservation protected');
  {const f=await fixture(),r=await f.run(f.request,'qa'),q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);await assert.rejects(reconciler.settle({...q,soldId:randomUUID()} as any));assert.equal((await get('Inventory',r.soldId))!.saleEndDate,null);check('queue substitution cannot update remaining inventory');}
  assert.equal(yahooSenderAuthenticated([{name:'Authentication-Results',value:'mx.google.com; dmarc=pass (p=REJECT) header.from=mail.yahoo.co.jp;'}]),true);
  for(const value of ['evil.invalid; dmarc=pass header.from=mail.yahoo.co.jp;','mx.google.com; dmarc=fail header.from=mail.yahoo.co.jp;','mx.google.com; dmarc=pass header.from=mail.yahoo.co.jp.evil.invalid;'])assert.equal(yahooSenderAuthenticated([{name:'Authentication-Results',value}]),false);
  check('only Google-received aligned Yahoo authentication can mark paid');

  {const f=await fixture();await f.run(f.request,'qa');const q=await get('Candidates',yahooPaymentKey(f.c.id)),before=await get('Inventory',f.id);await pay(f);copyFailure=true;await assert.rejects(reconciler.settle(q as any));copyFailure=false;assert.deepEqual(await get('Inventory',f.id),before);await reconciler.settle(q as any);check('photo-copy failure leaves pending stock intact; retry succeeds');}
  {const f=await fixture();await f.run(f.request,'qa');const q=await get('Candidates',yahooPaymentKey(f.c.id));await pay(f);await put('Inventory',{...await get('Inventory',f.id),note:'new note',updatedAt:new Date().toISOString()});await reconciler.settle(q as any);assert.equal((await get('Inventory',f.id))!.note,'new note');assert.equal((await get('Inventory',(await store.get(f.c.id))!.result!.soldId))!.note,'new note');check('unrelated note edit is preserved');}
  {const f=await fixture();await f.run(f.request,'qa');const before=await get('Inventory',f.id);await assert.rejects(f.run({...f.request,mutationId:randomUUID(),expectedUpdatedAt:before!.updatedAt},'qa'));assert.deepEqual(await get('Inventory',f.id),before);await pay(f);await reconciler.settle(await get('Candidates',yahooPaymentKey(f.c.id)) as any);check('second sale cannot overwrite payment reservation');}
  {const f=await fixture();await f.run(f.request,'qa');const soldId=randomUUID(),q=await get('Candidates',yahooPaymentKey(f.c.id)),c=(await store.get(f.c.id))!;
   const result={sourceId:f.id,soldId,soldQuantity:2,remainingQuantity:3,updatedAt:c.updatedAt};
   await put('Inventory',{...f.source,quantity:3});await put('Inventory',{...f.source,id:soldId,quantity:2,categoryIds:['other','sold','unpaid'],saleEndDate:null,customFields:JSON.stringify({__belloYahooPayment:{candidateId:c.id,auctionId:f.auction,state:'WAITING',unpaidCategoryId:'unpaid'}})});
   await put('Candidates',{...c,result});await put('Candidates',{id:q!.id,state:q!.state,receivedAt:q!.receivedAt,candidateId:c.id,auctionId:f.auction,...result});await pay(f);await reconciler.settle(await get('Candidates',yahooPaymentKey(f.c.id)) as any);assert.equal((await get('Inventory',f.id))!.quantity,3);assert.equal((await get('Inventory',soldId))!.quantity,2);assert.equal((await get('Inventory',soldId))!.saleEndDate,'2026-11-01');check('legacy pending sale: no second deduction');
  }

  const run=await reconciler.run();assert.ok(run.errors>=6);
  const again=await reconciler.run();assert.ok(again.errors>=6);assert.equal(again.applied,0);
  check('scheduled query retries and records visible conflict errors across repeated runs');
 }finally{
  for(const TableName of created){assert.ok(TableName.startsWith(prefix));await raw.send(new DeleteTableCommand({TableName}));}
  await Promise.all(created.map(TableName=>waitUntilTableNotExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName})));
  mkdirSync('artifacts/yahoo-deferred-payment-20261102',{recursive:true});writeFileSync('artifacts/yahoo-deferred-payment-20261102/aws-scratch-tests.json',JSON.stringify({checkedAt:new Date().toISOString(),passed,scratchTables:created,cleanup:'All scratch tables confirmed deleted'},null,2));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {GetCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createSoldOutService} from '../lib/inventory/soldOutCore';
import {japanToday,type SoldOutRequest} from '../lib/inventory/soldOutInput';
import {createCandidateStore} from '../lib/saleCandidates/storeCore';
import type {SaleCandidate} from '../lib/saleCandidates/model';
import {saleAmounts,type SalePricing} from '../lib/inventory/salePricing';
import {summarizeSales} from '../lib/inventory/sales';
import {buildMonthlyAggregates} from '../lib/inventory/salesAggregate';
import {stockCountTitle} from '../lib/inventory/stockCountTitle';

function fixture(quantity=5,withCandidate=false) {
  const id=randomUUID(), time='2026-10-24T01:00:00.000Z';
  const source={id,sku:'B-SOURCE',name:'椅子（元の商品名）',quantity,updatedAt:time,createdAt:'2026-09-01T00:00:00.000Z',categoryId:'active',categoryIds:['active','other'],locationId:'location',barcode:'SHARED-CODE',purchasePrice:1234,transactionDate:'2026-09-01',counterpartyName:'仕入先',purchaseQuantity:5,dailyPurchaseTotal:6170,salePrice:10000,market:'ヤフオク',externalProductId:'old-id',note:'元の備考',customFields:JSON.stringify({seatDimensions:'40cm',__belloEditedFields:['note'],__belloZaicoUnconvertedValues:[]}),images:[{storageKey:'inventory/source.jpg',type:'NORMAL'},{storageKey:'inventory/damage.jpg',type:'DAMAGE'}],sourceSystem:'ZAICO',sourceInventoryId:'98765',listingPartition:'ACTIVE'};
  let rows=new Map<string,any>([[`Inventory/${id}`,structuredClone(source)],...['active','sold','other'].map(x=>[`Category/${x}`,{id:x}]) as [string,any][]]);
  const candidate={id:'a'.repeat(64),state:'PENDING',updatedAt:time} as SaleCandidate;
  if(withCandidate)rows.set('Candidates/'+candidate.id,structuredClone(candidate));
  const state={fail:false,lost:false,copies:0,deleted:0,transactions:0,photoFailure:false};
  const db={send:async(command:any)=>{
    const input=command.input;
    if(command instanceof GetCommand)return {Item:structuredClone(rows.get(`${input.TableName}/${input.Key.id}`))};
    assert.ok(command instanceof TransactWriteCommand);state.transactions++;
    const staged=new Map(rows);
    // DynamoDB's transaction evaluates all conditions before exposing any writes.
    for(const op of input.TransactItems) {
      if(op.Update){const u=op.Update,current=staged.get(`${u.TableName}/${u.Key.id}`),v=u.ExpressionAttributeValues;
        if(u.TableName==='Candidates'){
          if(current?.state!=='PENDING'||current.updatedAt!==v[':version'])throw Object.assign(Error('candidate conflict'),{name:'TransactionCanceledException'});
          staged.set(`${u.TableName}/${u.Key.id}`,{...current,state:v[':done'],result:v[':result'],updatedAt:v[':now']});continue;
        }
        if(!current||current.updatedAt!==v[':version']||current.quantity!==v[':quantity']||current.outboundBatchId||current.outboundArrivalBatchId)throw Object.assign(Error('conditional'),{name:'TransactionCanceledException'});
        const updated={...current};for(const [alias,key] of Object.entries(u.ExpressionAttributeNames))updated[key as string]=v[alias.replace('#f',':v')];staged.set(`${u.TableName}/${u.Key.id}`,updated);
      }else if(op.Put){if(op.Put.ConditionExpression&&staged.has(`${op.Put.TableName}/${op.Put.Item.id}`))throw Object.assign(Error('conditional'),{name:'TransactionCanceledException'});staged.set(`${op.Put.TableName}/${op.Put.Item.id}`,structuredClone(op.Put.Item));}
      else if(op.Delete)staged.delete(`${op.Delete.TableName}/${op.Delete.Key.id}`);
    }
    if(state.fail)throw Object.assign(Error('injected failure'),{name:'TransactionCanceledException'});
    rows=staged;
    if(state.lost)throw Object.assign(Error('lost response'),{name:'TimeoutError'});
    return {};
  }} as unknown as DynamoDBDocumentClient;
  const run=createSoldOutService({db,table:x=>x,categories:async()=>[{id:'active',name:'販売中'},{id:'sold',name:'売り切れ'},{id:'other',name:'業者間'}],nextSku:async()=>`NEW-${randomUUID()}`,now:()=>time,copyPhotos:async(row,child)=>{state.copies++;if(state.photoFailure)throw Error('copy failed');return (row.images as Record<string,unknown>[]).map((image:any)=>({...image,storageKey:`inventory/${child}/${image.type}.jpg`}));},discardPhotos:async()=>{state.deleted++;},...(withCandidate?{saleCommit:(result:any,now:string)=>createCandidateStore(db,'Candidates').commit(candidate,'actor',result,now)}:{})});
  const request:SoldOutRequest={inventoryId:id,mutationId:randomUUID(),expectedUpdatedAt:time,quantity:1,name:'売却分の商品名',saleEndDate:'2026-10-20',externalProductId:'sale-id',market:'直接取引',salePrice:5000};
  if(withCandidate){request.sourceCandidateId=candidate.id;request.saleCommission=0;}
  return {source,state,run,request,candidate,get:(key:string)=>rows.get(`Inventory/${key}`),inventory:()=>[...rows].filter(([k])=>k.startsWith('Inventory/')).map(([,v])=>v),rows:()=>rows};
}
for(const [available,sold] of [[1,1],[5,2],[5,5],[10,1]])test(`${available}→${sold}: quantities, split identity, values and photos`,async()=>{
  const f=fixture(available),result=await f.run({...f.request,quantity:sold},'actor');
  const product=f.get(result.soldId);assert.equal(product.quantity,sold);assert.equal(product.name,f.request.name);assert.equal(product.saleEndDate,'2026-10-20');assert.equal(product.market,'直接取引');assert.equal(product.salePrice,5000);assert.equal(product.externalProductId,'sale-id');assert.deepEqual(product.categoryIds,['other','sold']);
  assert.equal(f.inventory().reduce((sum,p)=>sum+p.quantity,0),available);
  assert.equal(product.barcode,'SHARED-CODE');assert.equal(product.locationId,'location');assert.equal(product.purchasePrice,1234);assert.equal(product.transactionDate,'2026-09-01');assert.equal(product.counterpartyName,'仕入先');assert.equal(JSON.parse(product.customFields).seatDimensions,'40cm');
  if(sold<available){assert.notEqual(result.soldId,f.source.id);assert.notEqual(product.sku,f.source.sku);assert.equal(product.sourceSystem,'BELLO');assert.equal(product.sourceInventoryId,undefined);const remaining=f.get(f.source.id);for(const key of ['name','salePrice','market','externalProductId','categoryIds','images','purchasePrice','createdAt'])assert.deepEqual(remaining[key],f.source[key as keyof typeof f.source]);assert.equal(remaining.quantity,available-sold);assert.equal(product.images.length,2);assert.notEqual(product.images[0].storageKey,f.source.images[0].storageKey);assert.equal(product.images[1].type,'DAMAGE');assert.deepEqual(JSON.parse(remaining.customFields).__belloEditedFields,['note','quantity']);}
  else {assert.equal(result.soldId,f.source.id);assert.equal(f.inventory().length,1);assert.equal(f.state.copies,0);assert.deepEqual(product.images,f.source.images);}
  assert.ok(product.updatedAt>f.source.updatedAt);assert.ok(f.rows().has(`InventoryCategory/${result.soldId}:sold`));
});
test('over-quantity, zero, fraction, invalid date/price/market leave everything unchanged',async()=>{
  for(const fields of [{quantity:6},{quantity:0},{quantity:1.5},{saleEndDate:'2026-02-30'},{salePrice:-1},{salePrice:1.1},{market:'invalid'}]){const f=fixture();await assert.rejects(f.run({...f.request,...fields},'actor'));assert.deepEqual(f.get(f.source.id),f.source);assert.equal(f.state.transactions,0);assert.equal(f.state.copies,0);}
});
test('cancelled transaction rolls back both inventories and category/history writes',async()=>{const f=fixture();f.state.fail=true;await assert.rejects(f.run(f.request,'actor'));assert.deepEqual(f.get(f.source.id),f.source);assert.equal(f.inventory().length,1);assert.equal([...f.rows().keys()].some(k=>k.startsWith('InventoryHistory')),false);assert.equal(f.state.deleted,1);});
test('photo-copy failure leaves quantity unchanged',async()=>{const f=fixture();f.state.photoFailure=true;await assert.rejects(f.run(f.request,'actor'));assert.deepEqual(f.get(f.source.id),f.source);assert.equal(f.state.transactions,0);});
test('response lost after commit is reconciled, and retry never splits twice',async()=>{const f=fixture();f.state.lost=true;const first=await f.run(f.request,'actor'),second=await f.run(f.request,'actor');assert.deepEqual(first,second);assert.equal(f.inventory().length,2);assert.equal(f.state.transactions,1);});
test('simultaneous identical retries return one sale',async()=>{const f=fixture();const results=await Promise.all([f.run(f.request,'actor'),f.run(f.request,'actor')]);assert.deepEqual(results[0],results[1]);assert.equal(f.inventory().length,2);assert.equal(f.get(f.source.id).quantity,4);});
test('two terminals cannot sell against the same stale quantity',async()=>{const f=fixture();const results=await Promise.allSettled([f.run(f.request,'actor'),f.run({...f.request,mutationId:randomUUID()},'actor')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.inventory().length,2);assert.equal(f.get(f.source.id).quantity,4);});
test('receipt cannot be reused for different values or another actor',async()=>{const f=fixture();await f.run(f.request,'actor');await assert.rejects(f.run({...f.request,salePrice:2},'actor'));await assert.rejects(f.run(f.request,'other'));assert.equal(f.inventory().length,2);});
test('all-sale cannot be applied again with a fresh command',async()=>{const f=fixture(1);await f.run(f.request,'actor');await assert.rejects(f.run({...f.request,mutationId:randomUUID(),expectedUpdatedAt:f.get(f.source.id).updatedAt},'actor'));assert.equal(f.inventory().length,1);});
test('JST day boundary',()=>{assert.equal(japanToday(new Date('2026-10-23T15:00:00Z')),'2026-10-24');});
test('stock count changes only inside memo; preserve memo text, units, set count and dimensions',()=>{
 assert.equal(stockCountTitle('【濃い：在庫５脚・補修】椅子【2点セット】幅50cm',3),'【濃い：在庫3脚・補修】椅子【2点セット】幅50cm');
 assert.equal(stockCountTitle('【在庫： 10】棚【撮影済み】',9),'【在庫： 9】棚【撮影済み】');
 assert.equal(stockCountTitle('在庫10の棚【補修待ち】',2),'在庫10の棚【補修待ち】');
});
test('5→2 sale atomically records remaining title 3 and sold title 2, without touching other notes',async()=>{
 const f=fixture();f.get(f.source.id).name='【濃い：在庫5】椅子【補修済み】';
 const request={...f.request,quantity:2,name:'【濃い：在庫5】椅子（売却分）【補修済み】'};
 const r=await f.run(request,'actor');
 assert.equal(f.get(f.source.id).name,'【濃い：在庫3】椅子【補修済み】');
 assert.equal(f.get(r.soldId).name,'【濃い：在庫2】椅子（売却分）【補修済み】');
 assert.equal(f.get(f.source.id).quantity,3);assert.equal(f.get(r.soldId).quantity,2);
 assert.ok(JSON.parse(f.get(f.source.id).customFields).__belloEditedFields.includes('name'));
 await f.run(request,'actor');assert.equal(f.get(f.source.id).name,'【濃い：在庫3】椅子【補修済み】');
});
test('failed sale preserves original stock count title and quantity',async()=>{
 const f=fixture();f.get(f.source.id).name='【在庫5】椅子';f.state.fail=true;
 await assert.rejects(f.run({...f.request,quantity:2},'actor'));
 assert.equal(f.get(f.source.id).name,'【在庫5】椅子');assert.equal(f.get(f.source.id).quantity,5);
});
test('purchase candidate and sale split commit atomically with commission',async()=>{const f=fixture(5,true);const r=await f.run({...f.request,quantity:2,saleCommission:1320},'actor');assert.equal(f.get(f.source.id).quantity,3);assert.equal(f.get(r.soldId).quantity,2);assert.equal(f.get(r.soldId).saleCommission,1320);assert.equal(f.get(f.source.id).saleCommission,undefined);assert.equal(f.rows().get('Candidates/'+f.candidate.id).state,'DONE');});
test('deleted candidate rejects sale without quantity/history changes',async()=>{const f=fixture(5,true);f.rows().get('Candidates/'+f.candidate.id).state='DELETED';await assert.rejects(f.run(f.request,'actor'));assert.deepEqual(f.get(f.source.id),f.source);assert.equal(f.inventory().length,1);});
test('candidate transaction failure leaves both candidate and inventory unchanged',async()=>{const f=fixture(5,true);f.state.fail=true;await assert.rejects(f.run(f.request,'actor'));assert.equal(f.rows().get('Candidates/'+f.candidate.id).state,'PENDING');assert.deepEqual(f.get(f.source.id),f.source);});
test('lost candidate confirmation response and double click return only one split',async()=>{const f=fixture(5,true);f.state.lost=true;const r=await f.run(f.request,'actor');assert.deepEqual(await f.run(f.request,'actor'),r);assert.equal(f.inventory().length,2);assert.equal(f.rows().get('Candidates/'+f.candidate.id).state,'DONE');});

for(const [mode,units,itemsPerUnit,price,fee] of [['UNIT',2,1,10000,1000],['SET',1,2,20000,2000],['SET',2,2,20000,2000]] as const)test(`${mode} ${units} commercial units: physical stock and financial totals stay separate`,async()=>{
 const f=fixture(5,true),pricing:SalePricing={mode,units,itemsPerUnit,unitPrice:price,unitCommission:fee};
 const amounts=saleAmounts(pricing),request={...f.request,...amounts,pricing};
 const result=await f.run(request,'actor'),sold=f.get(result.soldId),remaining=f.get(result.sourceId);
 assert.equal(sold.quantity,units*itemsPerUnit);assert.equal(remaining.quantity,5-units*itemsPerUnit);
 assert.equal(sold.salePrice,price*units);assert.equal(sold.saleCommission,fee*units);
 assert.equal(sold.name,mode==='SET'?`【${itemsPerUnit}点セット】${request.name}`:request.name);
 assert.ok(!sold.categoryIds.includes('active'));assert.ok(sold.categoryIds.includes('sold'));
 assert.deepEqual(remaining.categoryIds,f.source.categoryIds);assert.equal(remaining.name,f.source.name);
 const records=f.inventory();assert.equal(summarizeSales(records,2026,10).totalSales,price*units);
 assert.equal(buildMonthlyAggregates(records)[0].totalSales,price*units);
 assert.equal(JSON.parse(sold.customFields).__belloSale.unitCommission,fee);
 assert.deepEqual(await f.run(request,'actor'),result);assert.equal(f.inventory().length,2);
});
test('set pricing rejects mismatched totals and over-stock without writes',async()=>{
 const f=fixture(5,true),pricing:SalePricing={mode:'SET',units:1,itemsPerUnit:2,unitPrice:15000,unitCommission:1500};
 await assert.rejects(f.run({...f.request,...saleAmounts(pricing),pricing,salePrice:30000},'actor'));
 await assert.rejects(f.run({...f.request,...saleAmounts({...pricing,units:3}),pricing:{...pricing,units:3}},'actor'));
 assert.equal(f.state.transactions,0);assert.deepEqual(f.get(f.source.id),f.source);
});

test('received shipping is one transaction amount on sold stock only, never revenue or expense',async()=>{
 const f=fixture(5,true);f.get(f.source.id).shippingCost=123;
 const pricing:SalePricing={mode:'SET',units:1,itemsPerUnit:2,unitPrice:34800,unitCommission:3479};
 const request={...f.request,...saleAmounts(pricing),pricing,market:'ヤフオク',saleShippingReceived:3260};
 const result=await f.run(request,'actor'),sold=f.get(result.soldId),source=f.get(f.source.id);
 assert.equal(sold.salePrice,34800);assert.equal(sold.saleCommission,3479);assert.equal(sold.shippingCost,123);
 assert.equal(JSON.parse(sold.customFields).__belloSale.shippingReceived,3260);
 assert.equal(JSON.parse(source.customFields).__belloSale,undefined);assert.equal(source.quantity,3);
 assert.deepEqual(await f.run(request,'actor'),result);assert.equal(f.state.transactions,1);
 await assert.rejects(f.run({...request,saleShippingReceived:3261},'actor'));
});
test('invalid shipping fails before any mutation; zero and unknown remain distinct',async()=>{
 for(const shipping of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){const f=fixture();await assert.rejects(f.run({...f.request,saleShippingReceived:shipping},'actor'));assert.equal(f.state.transactions,0);}
 for(const shipping of [0,null]){const f=fixture(1);const r=await f.run({...f.request,saleShippingReceived:shipping},'actor');assert.equal(JSON.parse(f.get(r.soldId).customFields).__belloSale.shippingReceived,shipping);}
});

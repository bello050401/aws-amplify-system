import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBaseOrder} from '../lib/saleCandidates/baseOrders';
import {originalForBatch,originalAvailable,ORIGINAL_RETENTION_MS,originalUrlTtl} from '../lib/photoRegistration/originalRetention';
import {saleAmounts,saleTitle} from '../lib/inventory/salePricing';
const order={order:{unique_key:'order-abc123',ordered:1792890000,fee_type:'base',shipping_fee:500,total:30500,payment:'creditcard',order_charge:{collected_fee:915},c_c_payment_transaction:{collected_fee:1138},order_items:[{item_id:123,order_item_id:456,title:'チェア',price:10000,amount:3}]}};
test('BASE exact listing identity, route and per-line fee; no buyer information stored',()=>{
 const source=structuredClone(order) as any;source.order.buyer_email='private@example.test';source.order.address='private';
 const [c]=parseBaseOrder(source);assert.equal(c.externalListingId,'123');assert.equal(c.quantity,3);assert.equal(c.orderRoute,'WEB');assert.equal(c.confirmedLineFee,2053);assert.equal(c.unitPrice,10000);
 assert.ok(!JSON.stringify(c).includes('private'));assert.equal(parseBaseOrder(order)[0].id,c.id);
 source.order.fee_type='payid_app';assert.equal(parseBaseOrder(source)[0].orderRoute,'PAY_ID_APP');
 source.order.fee_type='new';assert.equal(parseBaseOrder(source)[0].orderRoute,'UNKNOWN');assert.ok(parseBaseOrder(source)[0].warnings.length);
 source.order.cancelled=1792890010;assert.deepEqual(parseBaseOrder(source),[]);
});
test('BASE multi-line fee allocation adds to one order fee',()=>{const o=structuredClone(order);o.order.order_items.push({item_id:124,order_item_id:457,title:'テーブル',price:20000,amount:1});const cs=parseBaseOrder(o);assert.equal(cs.length,2);assert.equal(cs.reduce((s,c)=>s+c.confirmedLineFee!,0),2053);assert.notEqual(cs[0].id,cs[1].id);});
test('set fee fractions are rounded once after multiplying commercial units',()=>{assert.deepEqual(saleAmounts({mode:'SET',units:3,itemsPerUnit:2,unitPrice:10000,unitCommission:2053/3}),{quantity:6,salePrice:30000,saleCommission:2053});assert.equal(saleTitle('【2点セット】椅子',{mode:'SET',units:1,itemsPerUnit:3,unitPrice:0,unitCommission:0}),'【3点セット】椅子');});
test('original expires seven days after product link, not import; deleted stays deleted',()=>{
 const uploaded='2026-09-01T00:00:00Z',linked='2026-10-25T00:00:00Z';
 const o={key:'original.bin',fileName:'camera.jpg',mimeType:'image/jpeg',fileSize:12000000,sha256:'a'.repeat(64),requestedAt:uploaded,uploadedAt:uploaded,expiresAt:'2026-09-08T00:00:00Z'};
 const unlinked=originalForBatch(o);assert.ok(originalAvailable(unlinked,Date.parse(linked)));assert.equal(unlinked!.expiresAt,'');assert.equal(originalUrlTtl(unlinked!,60),60);
 const effective=originalForBatch(o,linked);assert.equal(Date.parse(effective!.expiresAt),Date.parse(linked)+ORIGINAL_RETENTION_MS);assert.ok(originalAvailable(effective,Date.parse(linked)+ORIGINAL_RETENTION_MS-1));assert.ok(!originalAvailable(effective,Date.parse(linked)+ORIGINAL_RETENTION_MS));assert.ok(!originalAvailable(originalForBatch({...o,purgedAt:uploaded},linked)));
});

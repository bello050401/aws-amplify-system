import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {kawagoeAttachments,orderNumber,validateArrivalDate,validateMovementQuantity} from './kawagoe';
import {splitInventoryRecord,remainingCustomFields} from './splitInventory';
import type {OutboundBatch,OutboundRow} from './types';
const row:OutboundRow={id:'item',batchId:'batch',inventoryId:'source',status:'PENDING',sourceQuantity:5,detailNote:'天板と脚分解。計3梱包。',snapshot:{id:'source',sku:'B000001',name:'椅子, "黒"',barcode:'0012345678901',quantity:3,unit:'脚',updatedAt:'2026-10-20T00:00:00Z',location:'所沢'}};
const batch={id:'batch',templateType:'KAWAGOE_V1',orderNumber:'20261020入荷_1',arrivalDate:'2026-10-20',rows:[row],locationId:'kawagoe'} as OutboundBatch;
test('warehouse receives two CP932 CSVs with exact template columns, barcode and selected quantity',()=>{const files=kawagoeAttachments(batch);assert.equal(files.length,2);const product=iconv.decode(files[0].data,'cp932'),arrival=iconv.decode(files[1].data,'cp932');assert.equal(product,'商品コード,JANコード,商品名\r\n0012345678901,0012345678901,"椅子, ""黒"""\r\n');assert.equal(arrival,'発注番号,入荷予定日,商品コード,入荷予定数,ヘッダ備考,入荷明細備考\r\n20261020入荷_1,2026/10/20,0012345678901,3,,天板と脚分解。計3梱包。\r\n');assert.match(files[1].fileName,/計3点/);assert.ok(!product.includes('B000001'));});
test('invalid dates, missing date and fractional/oversized quantities are rejected',()=>{for(const date of ['',undefined,'2026-02-30','2026-13-01','26/10/20'])assert.throws(()=>validateArrivalDate(date));for(const qty of [0,-1,1.5,6,NaN,'3'])assert.throws(()=>validateMovementQuantity(qty,5));assert.equal(orderNumber('2026-10-20',2),'20261020入荷_2');});
test('rows excluded by concurrency never enter either attachment',()=>{const files=kawagoeAttachments({...batch,rows:[row,{...row,id:'skip',status:'SKIPPED',snapshot:{...row.snapshot,name:'除外商品',barcode:'999'}}]});assert.ok(files.every(f=>!iconv.decode(f.data,'cp932').includes('除外商品')));});
test('ambiguous code and unsupported characters stop before sending',()=>{assert.throws(()=>kawagoeAttachments({...batch,rows:[row,{...row,id:'other',snapshot:{...row.snapshot,name:'別商品'}}]}),/異なる商品名/);assert.throws(()=>kawagoeAttachments({...batch,rows:[{...row,detailNote:'😀'}]}),/使用できない文字/);assert.throws(()=>kawagoeAttachments({...batch,rows:[{...row,snapshot:{...row.snapshot,barcode:''}}]}),/バーコード/);});
test('same product barcode is one master row and separate arrival notes are retained',()=>{const files=kawagoeAttachments({...batch,rows:[row,{...row,id:'other',detailNote:'別梱包'}]});assert.equal(iconv.decode(files[0].data,'cp932').split('\r\n').length,3);assert.match(iconv.decode(files[1].data,'cp932'),/別梱包/);assert.match(files[1].fileName,/計6点/);});
test('split makes an independent product without duplicated external listing or sync identities',()=>{const source={id:'source',locationId:'office',name:'椅子',barcode:row.snapshot.barcode,quantity:5,sourceSystem:'ZAICO',sourceInventoryId:'123',zaicoSnapshotJson:'{}',externalProductId:'mercari-id',purchaseQuantity:5,dailyPurchaseTotal:10000,plannedSalePrice:20000,images:[{storageKey:'old.jpg'}],customFields:JSON.stringify({material:'wood',__belloMobileWrite:{id:'old'}})};
 const child=splitInventoryRecord(source,{...row,splitInventoryId:'child',splitSku:'B000002',splitPrepared:true,splitImages:JSON.stringify([{storageKey:'new.jpg'}])},batch,['sale'],'user','now');assert.equal(child.quantity,3);assert.equal(child.barcode,source.barcode);assert.equal(child.locationId,'office');assert.equal((child as Record<string,unknown>).sourceInventoryId,undefined);assert.equal((child as Record<string,unknown>).externalProductId,undefined);assert.equal(child.purchaseQuantity,0);assert.equal(child.dailyPurchaseTotal,0);assert.equal((child as Record<string,unknown>).plannedSalePrice,20000);assert.deepEqual(child.images,[{storageKey:'new.jpg'}]);const custom=JSON.parse(child.customFields!);assert.equal(custom.material,'wood');assert.equal(custom.__belloMobileWrite,undefined);const parent=JSON.parse(remainingCustomFields(source,2)!);assert.ok(parent.__belloEditedFields.includes('quantity'));assert.equal(source.quantity,5);});

test('export-only product name enters CSV but never changes split inventory name',()=>{
 const r={...row,splitInventoryId:'child',splitSku:'B2',splitPrepared:true,splitImages:'[]',snapshot:{...row.snapshot,exportName:'倉庫用チェア'}};
 const data=kawagoeAttachments({...batch,rows:[r]});assert.match(iconv.decode(data[0].data,'cp932'),/倉庫用チェア/);
 assert.equal(r.snapshot.name,row.snapshot.name);
 const child=splitInventoryRecord({id:'source',name:row.snapshot.name,quantity:5,customFields:'{}'},r,batch,[],'user','now');
 assert.equal((child as Record<string,unknown>).name,row.snapshot.name);
});

test('川越の実CSVは在庫メモだけ省き、数量・元の商品名・他の備考を維持する',()=>{
 const r={...row,snapshot:{...row.snapshot,name:'【在庫4】MARUNI Table 135【天板傷】'}};
 const before=structuredClone(r),files=kawagoeAttachments({...batch,rows:[r]});
 const product=iconv.decode(files[0].data,'cp932'),arrival=iconv.decode(files[1].data,'cp932');
 assert.ok(product.includes('MARUNI Table 135【天板傷】'));assert.ok(!product.includes('在庫4'));
 assert.ok(arrival.includes(',0012345678901,3,,'));assert.deepEqual(r,before);
 const second={...r,id:'second',snapshot:{...r.snapshot,name:'【在庫２】MARUNI Table 135【天板傷】',quantity:2}};
 const combined=kawagoeAttachments({...batch,rows:[r,second]});
 assert.equal(iconv.decode(combined[0].data,'cp932').split('\r\n').length,3);
 assert.match(combined[1].fileName,/計5点/);
 assert.throws(()=>kawagoeAttachments({...batch,rows:[{...r,snapshot:{...r.snapshot,exportName:'【在庫4】'}}]}),/送信用の商品名/);
});

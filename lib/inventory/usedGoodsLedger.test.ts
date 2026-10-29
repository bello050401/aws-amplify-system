import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {buildUsedGoodsLedger,ledgerDate,ledgerYear,type LedgerSource} from './usedGoodsLedger';
import {usedGoodsLedgerWorkbook} from './usedGoodsLedgerWorkbook';

const source=(extra:LedgerSource={}):LedgerSource=>({id:'a',sku:'B001',name:'チェア',quantity:3,transactionDate:'2026-10-01',transactionType:'買受',purchaseQuantity:5,usedGoodsItemType:'椅子',counterpartyName:'登録済み取引先',counterpartyAddress:'登録済み住所',counterpartyOccupation:'登録済み職業',identityVerificationMethod:'登録済み確認方法',purchasePrice:1000,customFields:{usedGoodsFeature:'木製 ブラック',counterpartyAge:'40'},...extra});
test('year boundaries use transaction dates, not inventory creation dates',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',transactionDate:'2025-12-31'}),source({id:'b',transactionDate:'2026-01-01'}),source({id:'c',transactionDate:'2026-12-31'}),source({id:'d',transactionDate:'2027-01-01',createdAt:'2026-10-01'})],2026);
 assert.deepEqual(r.rows.map(x=>x.inventoryId),['b','c']);
 assert.equal(ledgerDate('2026-02-29'),'');assert.equal(ledgerDate('2024-02-29'),'2024-02-29');
 for(const bad of [null,NaN,1899,2101,'2026junk'])assert.throws(()=>ledgerYear(bad));
});
test('uses original ledger quantity and does not change the source',()=>{
 const s=source(),before=structuredClone(s),r=buildUsedGoodsLedger([s],2026);
 assert.equal(r.rows[0].quantity,5);assert.equal(r.rows[0].unitPrice,1000);assert.equal(r.issues.filter(x=>x.inventoryId).length,0);assert.deepEqual(s,before);
});
test('stock splitting excludes duplicate receipt while keeping a sale disposal',()=>{
 const r=buildUsedGoodsLedger([source(),source({id:'b',quantity:2,saleEndDate:'2026-10-02',salePrice:2000,customFields:{__belloStockSplit:{sourceInventoryId:'a',operation:'SOLD_OUT'},__belloSale:{physicalQuantity:2}}})],2026);
 assert.equal(r.rows.filter(x=>x.direction==='受入れ').length,1);assert.equal(r.rows.find(x=>x.direction==='払出し')?.quantity,2);assert.equal(r.omittedSplits,1);
 assert.equal(r.rows.find(x=>x.direction==='払出し')?.counterpartyName,'','never copy the supplier into the buyer column');
});
test('ordinary split inherited sale fields are not a new sale',()=>{
 const r=buildUsedGoodsLedger([source(),source({id:'b',saleEndDate:'2026-10-02',customFields:{__belloStockSplit:{sourceInventoryId:'a',operation:'STOCK_SPLIT'}}})],2026);
 assert.equal(r.rows.length,1);
});
test('restage transaction totals occur once, actual lot quantities remain separate',()=>{
 const ledger={quantity:7,purchaseTotal:11880};
 const r=buildUsedGoodsLedger([source({id:'a',dailyPurchaseTotal:11880,purchaseQuantity:7,customFields:{__restageImport:{date:'2026-10-01',goodsId:'1',quantity:3,ledger}}}),source({id:'b',dailyPurchaseTotal:11880,purchaseQuantity:7,customFields:{__restageImport:{date:'2026-10-01',goodsId:'2',quantity:4,ledger}}})],2026);
 assert.deepEqual(r.rows.map(x=>x.quantity),[3,4]);assert.equal(r.transactions.length,1);assert.equal(r.transactions[0].total,11880);assert.equal(r.transactions[0].quantity,7);
});
test('conflicting restage totals are not silently accepted',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',customFields:{__restageImport:{date:'2026-10-01',goodsId:'1',quantity:3,ledger:{quantity:7,purchaseTotal:100}}}}),source({id:'b',customFields:{__restageImport:{date:'2026-10-01',goodsId:'2',quantity:4,ledger:{quantity:8,purchaseTotal:200}}}})],2026);
 assert.equal(r.transactions[0].total,null);assert.match(r.transactions[0].issues.join(),/不一致/);
});
test('Yahoo order aggregates exact item totals plus allocated shipping once',()=>{
 const record=(id:string,total:number,shipping:number)=>source({id,customFields:{__yahooPurchaseImport:{auctionId:id,orderId:'order1',date:'2026-10-01',quantity:2,itemTotal:total,shipping}}});
 const r=buildUsedGoodsLedger([record('a',3001,501),record('b',5000,0)],2026);
 assert.equal(r.transactions[0].total,8502);assert.equal(r.transactions[0].quantity,4);
});
test('proven import duplicates flagged, equal names and barcodes are not deduplicated',()=>{
 const receipt={__yahooPurchaseImport:{auctionId:'r100',quantity:1}};
 const r=buildUsedGoodsLedger([source({id:'a',barcode:'same',customFields:receipt}),source({id:'b',barcode:'same',customFields:JSON.stringify(receipt)}),source({id:'c',barcode:'same'})],2026);
 assert.equal(r.rows.length,2);assert.ok(r.issues.some(x=>x.inventoryId==='b'&&x.message.includes('重複')));
});
test('missing dates and quantities remain visible, real zero price stays zero',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',transactionDate:null}),source({id:'b',quantity:9,purchaseQuantity:null,purchasePrice:0,customFields:'{}'})],2026);
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].quantity,null);assert.equal(r.rows[0].unitPrice,0);assert.ok(r.issues.find(x=>x.inventoryId==='a'));
});
test('sold/merged/deleted original receipts retained when data still exists',()=>{
 const r=buildUsedGoodsLedger([source({deletedAt:'2026-10-05',listingPartition:'MERGED'})],2026);assert.equal(r.rows.length,1);assert.match(r.rows[0].issues.join(),/削除済み/);
});
test('XLSX has typed dates/numbers, literal formula-like titles, filters, frozen headers',async()=>{
 const r=buildUsedGoodsLedger([source({name:'=HYPERLINK("https://example.invalid")',sku:'0000123'})],2026);
 const bytes=await usedGoodsLedgerWorkbook(r);const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(bytes).buffer);
 assert.deepEqual(book.worksheets.map(s=>s.name),['古物台帳','商品別明細','払出記録','仕入取引集計','確認事項']);const s=book.getWorksheet('商品別明細')!;
 assert.equal(s.getCell('A6').value,'0000123');assert.ok(s.getCell('B6').value instanceof Date);assert.equal(s.getCell('G6').value,5);assert.equal(s.getCell('N6').value,1000);assert.equal(s.getCell('E6').formula,undefined);assert.match(s.getCell('E6').text,/^=HYPERLINK/);
 assert.equal(s.views[0].state,'frozen');assert.ok(s.autoFilter);assert.equal(s.getCell('N6').numFmt,'#,##0');
});
test('same supplier and date is one summary row, daily total and quantity counted once',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',dailyPurchaseTotal:5000}),source({id:'b',dailyPurchaseTotal:5000}),source({id:'c',dailyPurchaseTotal:5000})],2026);
 assert.equal(r.supplierDays.length,1);assert.equal(r.supplierDays[0].total,5000);assert.equal(r.supplierDays[0].quantity,5);assert.equal(r.supplierDays[0].products,3);assert.equal(r.rows.length,3);
});
test('separate Yahoo transactions on same day sum exact amounts, including equal amounts',()=>{
 const r=buildUsedGoodsLedger(['a','b'].map(id=>source({id,customFields:{__yahooPurchaseImport:{auctionId:id,orderId:id,quantity:1,itemTotal:1501,shipping:500}}})),2026);
 assert.equal(r.supplierDays.length,1);assert.equal(r.supplierDays[0].total,4002);assert.equal(r.supplierDays[0].quantity,2);
});
test('different suppliers/dates remain separate and unnamed suppliers never merge',()=>{
 const r=buildUsedGoodsLedger([source(),source({id:'b',counterpartyName:'別会社'}),source({id:'c',transactionDate:'2026-10-02'}),source({id:'d',counterpartyName:''}),source({id:'e',counterpartyName:''})],2026);
 assert.equal(r.supplierDays.length,5);
});
test('conflicting daily totals are flagged rather than summed or silently picked',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',dailyPurchaseTotal:1000}),source({id:'b',dailyPurchaseTotal:2000})],2026);
 assert.equal(r.supplierDays[0].total,null);assert.match(r.supplierDays[0].issues.join(),/異なる日次合計/);
});
test('missing purchase total is not inferred from current stock or a transaction-wide quantity',()=>{
 const r=buildUsedGoodsLedger([source({quantity:2,purchaseQuantity:37,purchasePrice:1000})],2026);
 assert.equal(r.supplierDays[0].total,null);assert.match(r.supplierDays[0].issues.join(),/推測していません/);
});
test('empty year still creates a usable workbook without claiming all records complete',async()=>{
 const r=buildUsedGoodsLedger([source({transactionDate:null})],2025);assert.equal(r.rows.length,0);assert.equal(r.issues.length,1);assert.ok((await usedGoodsLedgerWorkbook(r)).length>1000);
});

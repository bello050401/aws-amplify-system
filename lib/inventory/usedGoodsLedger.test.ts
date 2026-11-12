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
 assert.equal(s.getCell('A6').value,'0000123');assert.ok(s.getCell('B6').value instanceof Date);assert.equal(s.getCell('G6').value,5);assert.equal(s.getCell('M6').value,1000);assert.equal(s.getCell('E6').formula,undefined);assert.match(s.getCell('E6').text,/^=HYPERLINK/);
 assert.equal(s.views[0].state,'frozen');assert.ok(s.autoFilter);assert.equal(s.getCell('M6').numFmt,'#,##0');
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
test('marketplace names alone must not merge different sellers',()=>{
 const r=buildUsedGoodsLedger(['a','b'].map(id=>source({id,counterpartyName:'ヤフオク'})),2026);
 assert.equal(r.supplierDays.length,2);assert.match(r.supplierDays[0].issues.join(),/販売サイト名/);
});
test('an inconsistent imported order cannot count its combined total on multiple supplier days',()=>{
 const records=['a','b'].map((id,i)=>source({id,transactionDate:i?'2026-10-02':'2026-10-01',customFields:{__yahooPurchaseImport:{auctionId:id,orderId:'same',quantity:1,itemTotal:1000,shipping:0}}}));
 const r=buildUsedGoodsLedger(records,2026);assert.equal(r.supplierDays.length,2);assert.ok(r.supplierDays.every(g=>g.total===null&&g.quantity===null));
});
test('missing purchase total is not inferred from current stock or a transaction-wide quantity',()=>{
 const r=buildUsedGoodsLedger([source({quantity:2,purchaseQuantity:37,purchasePrice:1000})],2026);
 assert.equal(r.supplierDays[0].total,null);assert.match(r.supplierDays[0].issues.join(),/推測していません/);
});
test('empty year still creates a usable workbook without claiming all records complete',async()=>{
 const r=buildUsedGoodsLedger([source({transactionDate:null})],2025);assert.equal(r.rows.length,0);assert.equal(r.issues.length,1);assert.ok((await usedGoodsLedgerWorkbook(r)).length>1000);
});

test('item descriptions use actual goods, retain full titles in detail, exclude workflow tags',()=>{
 const records=[source({id:'a',name:'アルペール チェア ブラック',usedGoodsItemType:'',categoryNames:['販売中','川越移動予定'],dailyPurchaseTotal:2000}),source({id:'b',name:'丸テーブル ホワイト',categoryNames:['補修待ち'],dailyPurchaseTotal:2000})];
 const r=buildUsedGoodsLedger(records,2026);
 assert.equal(r.supplierDays[0].itemTypes,'椅子・テーブル');
 assert.ok(!/販売中|川越移動予定|補修待ち/.test(r.supplierDays[0].itemTypes));
 assert.equal(r.rows[0].name,'アルペール チェア ブラック');
 assert.ok(!r.rows[0].issues.includes('品目が未記録'));
});
test('daily purchase total is counted once and shipping from each acquisition is added',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',dailyPurchaseTotal:3000,shippingCost:500}),source({id:'b',dailyPurchaseTotal:3000,shippingCost:200})],2026).supplierDays[0];
 assert.equal(r.purchaseAmount,3000);assert.equal(r.shipping,700);assert.equal(r.total,3700);
});
test('a one-item receipt can total purchase price plus shipping without a daily total',()=>{
 const r=buildUsedGoodsLedger([source({purchaseQuantity:1,quantity:0,purchasePrice:29700,shippingCost:2500})],2026);
 assert.equal(r.supplierDays[0].total,32200);assert.equal(r.rows[0].purchaseAmount,29700);assert.equal(r.rows[0].total,32200);
});
test('zero and blank shipping do not make a known receipt total unavailable',()=>{
 for(const shippingCost of [0,null,undefined,''])assert.equal(buildUsedGoodsLedger([source({purchaseQuantity:1,purchasePrice:0,shippingCost})],2026).supplierDays[0].total,0);
});
test('invalid recorded money is not silently converted to free shipping',()=>{
 for(const shippingCost of [-1,'oops',true,0.5])assert.equal(buildUsedGoodsLedger([source({purchaseQuantity:1,shippingCost})],2026).supplierDays[0].total,null);
});
test('Yahoo exact total avoids rounding and adding included shipping twice',()=>{
 const r=buildUsedGoodsLedger([source({purchasePrice:1167,purchaseQuantity:99,shippingCost:501,customFields:{__yahooPurchaseImport:{auctionId:'r1',quantity:3,itemTotal:3001,shipping:501}}})],2026);
 assert.equal(r.supplierDays[0].purchaseAmount,3001);assert.equal(r.supplierDays[0].shipping,501);assert.equal(r.supplierDays[0].total,3502);assert.equal(r.rows[0].total,3502);
});
test('Yahoo unknown shipping remains unknown, while an explicit inventory correction is used once',()=>{
 const record=source({customFields:{__yahooPurchaseImport:{auctionId:'r1',quantity:1,itemTotal:3000}}});
 assert.equal(buildUsedGoodsLedger([record],2026).supplierDays[0].total,null);
 assert.equal(buildUsedGoodsLedger([{...record,shippingCost:0}],2026).supplierDays[0].total,3000);
});
test('restage uses exact daily rounding once and does not reject different item descriptions',()=>{
 const ledger={quantity:7,purchaseTotal:11881};
 const r=buildUsedGoodsLedger(['a','b'].map((id,i)=>source({id,name:i?'テーブル':'椅子',shippingCost:i?200:300,customFields:{__restageImport:{date:'2026-10-01',goodsId:id,quantity:i?4:3,ledger}}})),2026);
 assert.equal(r.supplierDays[0].purchaseAmount,11881);assert.equal(r.supplierDays[0].shipping,500);assert.equal(r.supplierDays[0].total,12381);
});
test('split copies never add duplicated shipping',()=>{
 const r=buildUsedGoodsLedger([source({dailyPurchaseTotal:5000,shippingCost:500}),source({id:'b',dailyPurchaseTotal:5000,shippingCost:500,customFields:{__belloStockSplit:{sourceInventoryId:'a'}}})],2026);
 assert.equal(r.supplierDays[0].total,5500);
});
test('mixed legacy Yahoo records preserve the shipping-inclusive daily total',()=>{
 const r=buildUsedGoodsLedger([source({dailyPurchaseTotal:3500}),source({id:'b',dailyPurchaseTotal:3500,customFields:{__yahooPurchaseImport:{auctionId:'r1',quantity:1,itemTotal:3000,shipping:500}}})],2026);
 assert.equal(r.supplierDays[0].total,3500);assert.equal(r.supplierDays[0].shipping,null);assert.match(r.supplierDays[0].issues.join(),/混在/);
});
test('age and page counts are absent from every exported worksheet and age is not a missing-field issue',async()=>{
 const r=buildUsedGoodsLedger([source({purchaseQuantity:1,quantity:1,shippingCost:500})],2026);
 assert.ok(!r.issues.some(x=>/年齢|生年月日/.test(x.message)));
 const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(await usedGoodsLedgerWorkbook(r)).buffer);
 for(const s of book.worksheets)assert.ok(!/年齢|生年月日|商品ページ数/.test(JSON.stringify(s.getRow(5).values)));
 const s=book.getWorksheet('古物台帳')!;assert.equal(s.getCell('F6').value,1000);assert.equal(s.getCell('G6').value,500);assert.equal(s.getCell('H6').value,1500);
});
test('summary stays compact, full product names and totals are retained without duplicate totals',async()=>{
 const r=buildUsedGoodsLedger(Array.from({length:50},(_,i)=>source({id:String(i),name:`商品${i}：`+'大きなダイニングテーブル'.repeat(20),dailyPurchaseTotal:50000,shippingCost:10})),2026);
 const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(await usedGoodsLedgerWorkbook(r)).buffer);
 const s=book.getWorksheet('古物台帳')!;let text='',total=0;
 for(let i=6;i<=s.rowCount;i++){text+=s.getCell(`D${i}`).text;total+=Number(s.getCell(`H${i}`).value??0);assert.ok(s.getRow(i).height!<=409);}
 assert.equal(text,r.supplierDays[0].itemTypes);assert.equal(total,50500);assert.equal(s.rowCount,6);
 assert.equal(s.pageSetup.fitToWidth,1);assert.equal(s.pageSetup.paperSize,8);
 assert.equal(s.getColumn(9).hidden,true);assert.equal(s.getColumn(10).hidden,true);
 assert.ok(s.getCell('H6').note);
 const details=book.getWorksheet('商品別明細')!;
 assert.equal(details.getCell('E6').text,r.rows[0].name);assert.ok(details.rowCount>=55);
});

test('populated legacy prices do not establish quantity or whether a price covers a set',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',quantity:0,purchaseQuantity:8,purchasePrice:12750}),source({id:'b',quantity:1,purchaseQuantity:8,purchasePrice:8500})],2026);
 assert.equal(r.supplierDays[0].total,null);assert.equal(r.supplierDays[0].quantity,8);
 assert.deepEqual(r.rows.map(row=>row.unitPrice),[12750,8500]);
});
test('corroborated set memo counts once across split pages and does not change source',()=>{
 const records=[12750,8500,12750].map((purchasePrice,i)=>source({id:String(i),quantity:i===2?1:0,purchaseQuantity:8,purchasePrice,barcode:'same-lot',note:'8個計34,000円\n1個4250円\n定価9,700円'}));
 const before=JSON.stringify(records),r=buildUsedGoodsLedger(records,2026);
 assert.equal(r.supplierDays[0].total,34000);assert.match(r.supplierDays[0].amountBasis,/備考/);assert.equal(JSON.stringify(records),before);
});
test('explicit quantity and total memo resolves a multiple-unit record without using current stock',()=>{
 const r=buildUsedGoodsLedger([source({quantity:2,purchaseQuantity:10,purchasePrice:1361,barcode:'acquisition',note:'2脚で2,722円'})],2026);
 assert.equal(r.supplierDays[0].total,2722);
});
test('different barcodes, dates, suppliers and retail prices never share a memo total',()=>{
 const memo='2脚で2,722円';
 const records=['x','y'].map((barcode,i)=>source({id:String(i),quantity:2,purchasePrice:1361,barcode,note:memo}));
 assert.equal(buildUsedGoodsLedger(records,2026).supplierDays[0].total,5444);
 const r=buildUsedGoodsLedger([source({quantity:2,purchasePrice:1361,barcode:'a',note:'定価2脚で2,722円\n販売価格2脚で2,722円'})],2026);
 assert.equal(r.supplierDays[0].total,null);
});
test('address history pointer resolves only one agreed prior address; deletion and ambiguity are respected',()=>{
 const prior=source({id:'old',transactionDate:'2025-01-01',counterpartyAddress:'東京都の登録住所'});
 const current=source({counterpartyAddress:'履歴あり'});
 assert.equal(buildUsedGoodsLedger([prior,current],2026).rows[0].counterpartyAddress,'東京都の登録住所');
 assert.equal(buildUsedGoodsLedger([prior,{...current,counterpartyAddress:''}],2026).rows[0].counterpartyAddress,'');
 assert.equal(buildUsedGoodsLedger([prior,source({id:'other',transactionDate:'2025-02-01',counterpartyAddress:'異なる住所'}),current],2026).rows[0].counterpartyAddress,'履歴あり');
});
test('staff memo removed, real condition retained, category-only old features replaced from title',()=>{
 const r=buildUsedGoodsLedger([source({name:'【顧客への配送メモ】DAIKO ペンダントライト 3灯',customFields:{usedGoodsFeature:'椅子 デスク 棚'}})],2026);
 assert.equal(r.rows[0].name,'DAIKO ペンダントライト 3灯');assert.match(r.rows[0].feature,/照明/);assert.doesNotMatch(r.rows[0].feature,/デスク/);
 assert.equal(buildUsedGoodsLedger([source({customFields:{usedGoodsFeature:'座面に傷あり'}})],2026).rows[0].feature,'座面に傷あり');
});
test('desk lamps are lighting and coat hangers are not shelves; internal tags never become goods',()=>{
 const r=buildUsedGoodsLedger([source({id:'a',name:'ASPLUND デスクランプ テーブルランプ',categoryNames:['保留','GPT','事務所備品']}),source({id:'b',name:'Metro コートハンガー ハンガーラック'})],2026);
 assert.deepEqual(r.rows.map(r=>r.itemType),['照明','コートハンガー']);
});
test('memo duplicates cannot cross unverified marketplace sellers or exceed the stated acquisition quantity',()=>{
 const entry=source({quantity:1,purchasePrice:1000,barcode:'same',note:'2脚で2,000円'});
 const records=[{...entry,id:'a'},{...entry,id:'b'},{...entry,id:'c'}];
 assert.equal(buildUsedGoodsLedger(records,2026).supplierDays[0].total,null);
 const unknown=buildUsedGoodsLedger(records.map(r=>({...r,counterpartyName:'ヤフオク'})),2026);
 assert.ok(unknown.supplierDays.every(g=>g.total===null));
});
test('future or different supplier address never replaces a historical pointer',()=>{
 const r=buildUsedGoodsLedger([source({id:'past',transactionDate:'2025-01-01',counterpartyName:'別の仕入先',counterpartyAddress:'別住所'}),source({id:'future',transactionDate:'2027-01-01',counterpartyAddress:'移転後の住所'}),source({counterpartyAddress:'履歴あり'})],2026);
 assert.equal(r.rows[0].counterpartyAddress,'履歴あり');
});
test('a lot count of one must not turn multiple physical items into one unit of cost',()=>{
 for(const extra of [{quantity:10},{quantity:0,name:'【4点山】テーブル'},{quantity:1,name:'【2脚セット】チェア'}]){
   const r=buildUsedGoodsLedger([source({purchaseQuantity:1,purchasePrice:6277,...extra})],2026);
   assert.equal(r.supplierDays[0].total,null);
 }
});
test('history placeholders such as new goods are not treated as a supplier address',()=>{
 const r=buildUsedGoodsLedger([source({id:'prior',transactionDate:'2025-01-01',counterpartyAddress:'新品'}),source({counterpartyAddress:'履歴あり'})],2026);
 assert.equal(r.rows[0].counterpartyAddress,'履歴あり');
 assert.match(buildUsedGoodsLedger([source({counterpartyAddress:'新品'})],2026).rows[0].issues.join(),/実住所/);
});

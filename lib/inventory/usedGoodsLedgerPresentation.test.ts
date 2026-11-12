import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {buildUsedGoodsLedger,type LedgerSource} from './usedGoodsLedger';
import {ledgerPresentation} from './usedGoodsLedgerPresentation';
import {usedGoodsLedgerWorkbook} from './usedGoodsLedgerWorkbook';

const entry=(extra:LedgerSource={}):LedgerSource=>({id:'a',sku:'B001',name:'木製テーブル',quantity:2,purchasePrice:10000,transactionDate:'2026-10-01',transactionType:'買受',counterpartyName:'検証用仕入先',counterpartyAddress:'検証用住所',counterpartyOccupation:'リサイクル販売業',identityVerificationMethod:'対面にて確認',customFields:{usedGoodsFeature:'木製・円形・茶色'},...extra});
async function workbook(rows:LedgerSource[]){const ledger=buildUsedGoodsLedger(rows,2026);const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(await usedGoodsLedgerWorkbook(ledger)).buffer);return {ledger,book};}

test('summary-to-detail joins use inventory IDs, even with duplicated management numbers',()=>{
 const rows=[entry(),entry({id:'b',counterpartyName:'別仕入先'}),entry({id:'c',name:'チェア'}),entry({id:'d',transactionDate:'2026-10-02'})];
 const before=structuredClone(rows),ledger=buildUsedGoodsLedger(rows,2026),p=ledgerPresentation(ledger);
 assert.equal(p.groups.length,3);assert.equal(p.byInventoryId.size,4);
 assert.equal(p.byInventoryId.get('a')?.ledgerNo,p.byInventoryId.get('c')?.ledgerNo);
 assert.notEqual(p.byInventoryId.get('a')?.ledgerNo,p.byInventoryId.get('b')?.ledgerNo);
 assert.notEqual(p.byInventoryId.get('a')?.ledgerNo,p.byInventoryId.get('d')?.ledgerNo);
 assert.deepEqual(rows,before);assert.equal(new Set(p.groups.map(g=>g.ledgerNo)).size,3);
});

test('unknown total, zero yen and known subset subtotal are visibly different',async()=>{
 const {ledger,book}=await workbook([entry({id:'unknown',quantity:0,purchaseQuantity:20}),entry({id:'free',transactionDate:'2026-10-02',purchasePrice:0}),entry({id:'known',transactionDate:'2026-10-03',dailyPurchaseTotal:25000,shippingCost:500})]);
 const p=ledgerPresentation(ledger);assert.equal(p.knownAmount,25500);assert.equal(p.unknownAmountCount,1);assert.equal(p.knownAmountCount,2);
 const s=book.getWorksheet('古物台帳')!;
 assert.equal(s.getCell('H6').value,'未確定');assert.equal(s.getCell('H7').value,0);assert.equal(s.getCell('H8').value,25500);
 assert.match(s.getCell('A4').text,/小計 25,500円.*金額未確定 1組.*年間総額ではありません/);
 assert.equal(s.getColumn(16).hidden,false);assert.match(s.getCell('P6').text,/金額未確定/);
 assert.match(s.getCell('E5').text,/出力時点/);
});

test('missing identity, verification, type and feature are exposed in summary status',()=>{
 const ledger=buildUsedGoodsLedger([entry({name:'品物',transactionType:'',counterpartyName:'',counterpartyAddress:'',counterpartyOccupation:'',identityVerificationMethod:'',customFields:{}})],2026);
 const flags=ledgerPresentation(ledger).groups[0].recordStatus;
 for(const text of ['仕入先未記録','住所の記録不足','本人確認方法未記録','職業未記録','取引区分未記録'])assert.ok(flags.includes(text),text);
});

test('printed summary, full detail and issues share visible reference numbers',async()=>{
 const {book}=await workbook([entry({counterpartyAddress:'履歴あり'})]);
 assert.equal(book.getWorksheet('古物台帳')!.getCell('O6').value,'2026-001');
 const detail=book.getWorksheet('商品別明細')!;assert.equal(detail.getCell('U6').value,'2026-001');assert.equal(detail.getColumn(21).hidden,false);assert.equal(detail.getColumn(4).hidden,false);
 const checks=book.getWorksheet('確認事項')!;assert.equal(checks.getCell('E6').value,'2026-001');
 for(const s of book.worksheets){assert.match(s.getCell('A1').text,/出力日時.*日本時間/);assert.equal(s.pageSetup.paperSize,8);assert.equal(s.pageSetup.fitToWidth,1);assert.doesNotMatch(JSON.stringify(s.getRow(5).values),/年齢|生年月日|商品ページ数/);}
});

test('long features continue with a reference and no lost text or duplicated amounts',async()=>{
 const feature='座面に擦れがあります。脚先に傷があります。\n'.repeat(120);
 const {book}=await workbook([entry({customFields:{usedGoodsFeature:feature}})]);
 const detail=book.getWorksheet('商品別明細')!;let text='',price=0;
 assert.ok(detail.rowCount>6);
 for(let n=6;n<=detail.rowCount;n++){
  text+=detail.getCell(n,8).text;price+=typeof detail.getCell(n,13).value==='number'?Number(detail.getCell(n,13).value):0;
  assert.match(detail.getCell(n,21).text,/2026-001/);assert.ok(detail.getCell(n,2).value instanceof Date);assert.ok(detail.getRow(n).height!<=409);
 }
 assert.equal(text,feature.trim());assert.equal(price,10000);
});

test('numeric summary remains purchase plus shipping and preserves all inventory counts',async()=>{
 const {ledger,book}=await workbook([entry({quantity:2,dailyPurchaseTotal:20000,shippingCost:500}),entry({id:'b',quantity:3,dailyPurchaseTotal:20000,shippingCost:1000})]);
 assert.equal(ledger.supplierDays[0].quantity,5);
 const s=book.getWorksheet('古物台帳')!;assert.equal(s.getCell('E6').value,5);assert.equal(s.getCell('F6').value,20000);assert.equal(s.getCell('G6').value,1500);assert.equal(s.getCell('H6').value,21500);
});

test('sale sheet displays recorded sale price without a purchase label or a misleading receipt reference',async()=>{
 const {book}=await workbook([entry({saleEndDate:'2026-10-05',salePrice:40000})]);
 const sales=book.getWorksheet('払出記録')!;
 assert.equal(sales.getCell('M5').text,'登録販売価格\n（円）');assert.equal(sales.getCell('M6').value,40000);assert.equal(sales.getCell('I6').text,'未記録');assert.equal(sales.getColumn(21).hidden,true);
 const issues=book.getWorksheet('確認事項')!;
 for(let n=6;n<=issues.rowCount;n++)if(issues.getCell(n,4).text.startsWith('払出し：'))assert.equal(issues.getCell(n,5).text,'');
});

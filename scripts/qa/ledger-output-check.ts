import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ExcelJS from 'exceljs';
import {buildUsedGoodsLedger, type LedgerSource} from '../../lib/inventory/usedGoodsLedger';
import {usedGoodsLedgerWorkbook} from '../../lib/inventory/usedGoodsLedgerWorkbook';
import {inventoryCategoryIds} from '../../lib/inventory/categories';

async function main(){
 const dir='artifacts/ledger-20261112';
 const snapshot=JSON.parse(await fs.readFile(`${dir}/enriched-source.json`,'utf8'));
 const categories=new Map<string,string>(snapshot.categories.map((c:{id:string;name:string})=>[c.id,c.name]));
 const sources:LedgerSource[]=snapshot.rows.map((r:LedgerSource)=>({...r,categoryNames:inventoryCategoryIds(r).map(id=>categories.get(id)).filter(Boolean)}));
 const original=JSON.stringify(sources);
 await fs.writeFile(`${dir}/baseline.ts`,execFileSync('git',['show','c5090d5b489ce26669f8438a7ef0b8b7bd924333:lib/inventory/usedGoodsLedger.ts']));
 const baselinePath=pathToFileURL(path.resolve(`${dir}/baseline.ts`)).href;
 const baseline=(await import(baselinePath)).buildUsedGoodsLedger(sources,2026);
 const started=performance.now();const ledger=buildUsedGoodsLedger(sources,2026);
 const bytes=await usedGoodsLedgerWorkbook(ledger);await fs.writeFile(`${dir}/BELLO_古物台帳_2026年.xlsx`,bytes);
 const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(bytes).buffer);
 const summary=book.getWorksheet('古物台帳')!;
 assert.equal(original,JSON.stringify(sources),'read-only projection');
 assert.equal(ledger.rows.length+ledger.omittedLowValue,baseline.rows.length,'only explicitly excluded low-value receipts may be omitted');
 for(const sheet of book.worksheets){
   assert.ok(!/年齢|生年月日|商品ページ数/.test(JSON.stringify(sheet.getRow(5).values)));
   sheet.eachRow(row=>assert.ok(!row.height||row.height<=409));
 }
 for(const group of ledger.supplierDays){
   if(group.purchaseAmount!==null&&group.shipping!==null&&group.total!==null)assert.equal(group.total,group.purchaseAmount+group.shipping);
 }
 let exportedTotal=0;for(let i=6;i<=summary.rowCount;i++)exportedTotal+=Number(summary.getCell(`H${i}`).value??0);
 assert.equal(exportedTotal,ledger.supplierDays.reduce((n,g)=>n+(g.total??0),0),'continuation rows never repeat money');
 const report={checkedAt:new Date().toISOString(),inventoryCount:sources.length,receiptCount:ledger.rows.filter(r=>r.direction==='受入れ').length,disposalCount:ledger.rows.filter(r=>r.direction==='払出し').length,groups:ledger.supplierDays.length,
   before:{amountKnown:baseline.supplierDays.filter((g:{total:number|null})=>g.total!==null).length,itemMissing:baseline.rows.filter((r:{itemType:string})=>!r.itemType).length},
   after:{amountKnown:ledger.supplierDays.filter(g=>g.total!==null).length,itemMissing:ledger.rows.filter(r=>!r.itemType).length,amountNeedsReview:ledger.supplierDays.filter(g=>g.total===null).length,splitExcluded:ledger.omittedSplits,excelBytes:bytes.length,exportMs:Math.round(performance.now()-started)},
   sheets:book.worksheets.map(s=>({name:s.name,rows:s.rowCount,columns:s.columnCount})),checks:['source unchanged','receipt/disposal counts unchanged','money reconciled','no age/DOB/page-count columns','no repeated totals on continuation rows']};
 await fs.writeFile(`${dir}/output-check-review.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 const fixture=buildUsedGoodsLedger([
   {id:'sample1',quantity:2,sku:'B00001',transactionDate:'2026-11-12',name:'arper アルペール Catifa46 ダイニングチェア ブラック',categoryNames:['補修待ち'],usedGoodsItemType:'椅子',purchaseQuantity:3,purchasePrice:10000,dailyPurchaseTotal:50000,shippingCost:2000,transactionType:'買受',counterpartyName:'取引先サンプル株式会社',counterpartyAddress:'東京都（表示確認用）',counterpartyOccupation:'リサイクル販売業',identityVerificationMethod:'登録済みの本人確認方法',customFields:{usedGoodsFeature:'椅子／ブラック／arper'}},
   {id:'sample2',quantity:1,sku:'B00002',transactionDate:'2026-11-12',name:'丸テーブル ナチュラル 木製',categoryNames:['撮影待ち'],usedGoodsItemType:'テーブル',purchaseQuantity:3,purchasePrice:30000,dailyPurchaseTotal:50000,shippingCost:3000,transactionType:'買受',counterpartyName:'取引先サンプル株式会社',counterpartyAddress:'東京都（表示確認用）',counterpartyOccupation:'リサイクル販売業',identityVerificationMethod:'登録済みの本人確認方法',customFields:{usedGoodsFeature:'テーブル／木製／円形'}},
 ],2026);
 await fs.writeFile(`${dir}/表示確認用.xlsx`,await usedGoodsLedgerWorkbook(fixture));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

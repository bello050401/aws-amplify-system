import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {buildUsedGoodsLedger,type LedgerSource} from '../../lib/inventory/usedGoodsLedger';
import {inventoryCategoryIds} from '../../lib/inventory/categories';
import {usedGoodsLedgerWorkbook} from '../../lib/inventory/usedGoodsLedgerWorkbook';
async function main(){
 const dir='artifacts/ledger-20261112',snapshot=JSON.parse(await fs.readFile(`${dir}/enriched-source.json`,'utf8'));
 const names=new Map<string,string>(snapshot.categories.map((c:{id:string;name:string})=>[c.id,c.name]));
 const sources:LedgerSource[]=snapshot.rows.map((r:LedgerSource)=>({...r,categoryNames:inventoryCategoryIds(r).map(id=>names.get(id)).filter(Boolean)}));
 const before=JSON.stringify(sources),ledger=buildUsedGoodsLedger(sources,2026),receipts=ledger.rows.filter(r=>r.direction==='受入れ');
 assert.equal(JSON.stringify(sources),before);
 assert.equal(ledger.supplierDays.reduce((n,g)=>n+(g.quantity??0),0),receipts.reduce((n,r)=>n+(r.quantity??0),0));
 assert.ok(receipts.every(r=>r.quantity!==null),'all current source quantities are valid or blank-as-zero');
 assert.equal(ledger.exclusions.length,ledger.omittedLowValue);
 for(const g of ledger.supplierDays)if(g.purchaseAmount!==null&&g.shipping!==null)assert.equal(g.total,g.purchaseAmount+g.shipping);
 const bytes=await usedGoodsLedgerWorkbook(ledger);await fs.writeFile(`${dir}/BELLO_古物台帳_2026年.xlsx`,bytes);
 const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(bytes).buffer);
 const summary=book.getWorksheet('古物台帳')!;
 let exported=0;for(let i=6;i<=summary.rowCount;i++)exported+=Number(summary.getCell(i,8).value??0);
 assert.equal(exported,ledger.supplierDays.reduce((n,g)=>n+(g.total??0),0));
 assert.equal(summary.getCell(5,5).text,'数量（在庫欄の合計）');
 for(const s of book.worksheets){assert.equal(s.pageSetup.fitToWidth,1);assert.ok(!/年齢|生年月日|商品ページ数/.test(JSON.stringify(s.getRow(5).values)));}
 const report={checkedAt:new Date().toISOString(),inventory:sources.length,receipts:receipts.length,disposals:ledger.rows.length-receipts.length,groups:ledger.supplierDays.length,quantity:ledger.supplierDays.reduce((n,g)=>n+(g.quantity??0),0),knownAmounts:ledger.supplierDays.filter(g=>g.total!==null).length,unknownAmounts:ledger.supplierDays.filter(g=>g.total===null).length,omittedLowValue:ledger.omittedLowValue,omittedSplits:ledger.omittedSplits,quantityIssues:receipts.filter(r=>r.issues.some(i=>i.startsWith('数量'))).length,shippingUnknown:receipts.filter(r=>r.shipping===null).length,sourceUnchanged:true,excelBytes:bytes.length,exclusions:ledger.exclusions};
 await fs.writeFile(`${dir}/quantity-check.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

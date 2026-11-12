import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import ExcelJS from 'exceljs';
import {buildUsedGoodsLedger,type LedgerSource,type UsedGoodsLedger} from '../../lib/inventory/usedGoodsLedger';
import {inventoryCategoryIds,type CategoryRecord} from '../../lib/inventory/categories';
import {ledgerPresentation} from '../../lib/inventory/usedGoodsLedgerPresentation';
import {usedGoodsLedgerWorkbook} from '../../lib/inventory/usedGoodsLedgerWorkbook';

async function main(){
 const dir='artifacts/ledger-readability-20261112';mkdirSync(dir,{recursive:true});
 const source=JSON.parse(readFileSync(process.argv[2]||'artifacts/ledger-20261112/source.json','utf8'));
 const names=new Map<string,string>(source.categories.map((c:{id:string;name:string})=>[c.id,c.name]));
 const rows:LedgerSource[]=source.rows.map((r:LedgerSource)=>({...r,categoryNames:inventoryCategoryIds(r as CategoryRecord).map(id=>names.get(id)).filter(Boolean)}));
 const before=JSON.stringify(rows),started=performance.now();
 const ledger=buildUsedGoodsLedger(rows,2026,'2026-11-12T06:00:00.000Z');
 // Compare all existing calculated fields with the production base, not a second
 // implementation of the modified exporter. Raw source stays in ignored artifacts.
 const baseline=execFileSync('git',['show','5dc45de3fc919d6ba924c80cbf2d300ed5222d7e:lib/inventory/usedGoodsLedger.ts'],{encoding:'utf8'});
 const baselineFile=path.resolve(dir,'baseline.cjs');
 await build({stdin:{contents:baseline,resolveDir:path.resolve('lib/inventory'),loader:'ts'},outfile:baselineFile,bundle:true,platform:'node',format:'cjs',packages:'external'});
 const old=createRequire(import.meta.url)(baselineFile).buildUsedGoodsLedger(rows,2026,ledger.generatedAt);
 const strip=(l:UsedGoodsLedger)=>({...l,supplierDays:l.supplierDays.map(({inventoryIds,...g})=>g)});
 assert.deepEqual(strip(ledger),old);assert.equal(JSON.stringify(rows),before);
 const p=ledgerPresentation(ledger),bytes=await usedGoodsLedgerWorkbook(ledger);
 writeFileSync(path.join(dir,'BELLO_古物台帳_2026年.xlsx'),bytes);
 writeFileSync(path.join(dir,'expected-ledger.json'),JSON.stringify(ledger));
 const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(bytes).buffer);
 const daily=book.getWorksheet('古物台帳')!,detail=book.getWorksheet('商品別明細')!;
 const numericSum=(column:number)=>{let n=0;for(let i=6;i<=daily.rowCount;i++){const value=daily.getCell(i,column).value;if(typeof value==='number')n+=value;}return n;};
 assert.equal(numericSum(8),p.knownAmount);
 assert.equal(numericSum(5),ledger.rows.filter(r=>r.direction==='受入れ').reduce((n,r)=>n+(r.quantity??0),0));
 const detailRefs=new Map<string,number>();let continuationRows=0;
 for(let i=6;i<=detail.rowCount;i++){
  const reference=detail.getCell(i,21).text;
  assert.match(reference,/^2026-\d{3,}(（続き）)?$/);
  if(reference.endsWith('（続き）')){continuationRows++;continue;}
  detailRefs.set(reference,(detailRefs.get(reference)||0)+1);
 }
 for(const group of p.groups)assert.equal(detailRefs.get(group.ledgerNo),group.inventoryIds.length);
 for(const s of book.worksheets)for(let n=6;n<=s.rowCount;n++)assert.ok(s.getRow(n).height!<=409);
 // An anonymous, independently inspectable specimen covers complete, missing,
 // imported, long-description and actual-zero data without exposing counterparties.
 const item=(extra:LedgerSource={}):LedgerSource=>({id:'sample-a',sku:'見本001',name:'木製ダイニングチェア ブラック',quantity:3,transactionDate:'2026-10-01',transactionType:'買受',counterpartyName:'検証用家具店（架空）',counterpartyAddress:'東京都（検証用の架空住所）',counterpartyOccupation:'リサイクル販売業',identityVerificationMethod:'対面している相手の身分証明書を確認',purchasePrice:10000,customFields:{usedGoodsFeature:'椅子／木製／ブラック／背もたれに小傷'},...extra});
 const fixture=buildUsedGoodsLedger([
  item(),item({id:'sample-b',sku:'見本002',name:'円形テーブル オーク材',quantity:1,purchasePrice:22000,shippingCost:1000,customFields:{usedGoodsFeature:'テーブル／オーク材／円形／直径90cm'}}),
  item({id:'sample-c',sku:'見本003',transactionDate:'2026-10-02',name:'サイドテーブル',quantity:0,purchaseQuantity:25,counterpartyAddress:''}),
  item({id:'sample-d',sku:'見本004',transactionDate:'2026-10-03',purchasePrice:0,quantity:1}),
  item({id:'sample-e',sku:'見本005',transactionDate:'2026-10-04',saleEndDate:'2026-10-06',salePrice:22000,customFields:{usedGoodsFeature:'幅60cm／奥行65cm／高さ80cm。座面に擦れ。\n'.repeat(30),__yahooPurchaseImport:{auctionId:'sample-id',orderId:'sample-order',quantity:1,itemTotal:15000,shipping:1000}}})
 ],2026,ledger.generatedAt);
 writeFileSync(path.join(dir,'帳簿見本_架空データ.xlsx'),await usedGoodsLedgerWorkbook(fixture));
 const report={checkedAt:new Date().toISOString(),sourceReadAt:source.checkedAt,sourceRecords:rows.length,receipts:ledger.rows.filter(r=>r.direction==='受入れ').length,disposals:ledger.rows.filter(r=>r.direction==='払出し').length,supplierDays:p.groups.length,knownAmountGroups:p.knownAmountCount,unknownAmountGroups:p.unknownAmountCount,knownSubtotal:p.knownAmount,inventoryQuantity:numericSum(5),detailContinuationRows:continuationRows,workbookBytes:bytes.length,durationMs:Math.round(performance.now()-started),baselineCalculatedFieldsIdentical:true,sourceUnchanged:true,crossReferencesVerified:true,sheets:book.worksheets.map(s=>({name:s.name,rows:s.rowCount,columns:s.columnCount}))};
 writeFileSync(path.join(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

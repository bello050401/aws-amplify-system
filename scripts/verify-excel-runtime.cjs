// The ExcelJS uuid override must preserve real XLSX serialization, not just load.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const ExcelJS=require('exceljs'),JSZip=require('jszip');
async function main(){
 const uuidPath=require.resolve('uuid/package.json',{paths:[path.dirname(require.resolve('exceljs'))]});
 assert.equal(JSON.parse(fs.readFileSync(uuidPath,'utf8')).version,'11.1.1');
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('在庫');
 sheet.addRow(['商品名','バーコード','数量','単価']);
 sheet.addRow(['椅子／検証用','0012345678901',5,1188]);
 sheet.addConditionalFormatting({ref:'C2:C2',rules:[{type:'iconSet',iconSet:'3Stars',cfvo:[{type:'percent',value:0},{type:'percent',value:33},{type:'percent',value:67}]}]});
 const bytes=await book.xlsx.writeBuffer();
 const zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
 assert.match(xml,/<x14:cfRule[^>]+id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/);
 const restored=new ExcelJS.Workbook();await restored.xlsx.load(bytes);
 assert.deepEqual(restored.getWorksheet('在庫').getRow(2).values.slice(1),['椅子／検証用','0012345678901',5,1188]);
 assert.equal(restored.getWorksheet('在庫').conditionalFormattings[0].rules[0].iconSet,'3Stars');
 console.log('PASS patched UUID: CommonJS ExcelJS writes valid extended-format UUID and preserves Japanese, barcode, quantity and price after XLSX round trip');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

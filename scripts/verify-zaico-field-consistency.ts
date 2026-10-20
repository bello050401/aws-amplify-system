import assert from 'node:assert/strict';
import {ZAICO_FIELD_CHOICES,choicesWithCurrentValue} from '../lib/inventory/zaicoFieldChoices';
import {ALL_EXTENDED_FIELDS,parseExtendedValues} from '../lib/inventory/extendedFields';
import {DETAIL_FIELDS} from '../mobile/src/domain/detailFields';
import {normalizeCalendarDate} from '../lib/inventory/calendarDate';
import {parseZaicoDate,mapZaicoOptionalAttributes} from '../lib/inventory/zaicoMapping';
import {parseImportDate,parseXlsxFile} from '../lib/inventory/inventoryImport';
import {toCsv,parseCsv} from '../lib/inventory/csv';
import {splitCategoryNames} from '../lib/inventory/categories';
import ExcelJS from 'exceljs';

async function main(){
 for(const [key,options]of Object.entries(ZAICO_FIELD_CHOICES)){
  const pc=ALL_EXTENDED_FIELDS.find(f=>f.key===key)!;const pwa=DETAIL_FIELDS.find(f=>f.key===key)!;
  assert.equal(pc.type,'select');assert.deepEqual(pc.options!.filter(x=>x.value).map(x=>x.value),options);assert.deepEqual(pwa.options,options);
  for(const value of ['',...options,'以前の保存値']) assert.equal((parseExtendedValues({[key]:value}) as Record<string,unknown>)[key],value||null);
  assert.ok(choicesWithCurrentValue(options,'以前の保存値').includes('以前の保存値'));
 }
 assert.deepEqual(ZAICO_FIELD_CHOICES.lengthAdjustable,['可能','不可']);
 assert.equal(DETAIL_FIELDS.find(f=>f.key==='conditionRating')!.kind,'multiline');
 assert.equal(DETAIL_FIELDS.find(f=>f.key==='usedGoodsFeature')!.kind,'multiline');
 for(const [input,want]of [['2023/2/21 0:00','2023-02-21'],['2023年4月28日','2023-04-28'],['2024-2-29','2024-02-29'],['2023-2-29',null],['2026/4/31',null],['2026-13-1',null],['2026-1-0',null],['44822',null],['2023/2/21 24:00',null]] as const){
  assert.equal(normalizeCalendarDate(input),want);assert.equal(parseZaicoDate(input,'日付').value,want);const warnings:string[]=[];assert.equal(parseImportDate(input,'日付',warnings),want);assert.equal(warnings.length,want?0:1);
 }
 const raw=[{name:'⚪︎高さ（cm）',value:'77.5　アーム高さ65'},{name:'1回目値下げ時の金額（30日）',value:'34,800'},{name:'⚪︎コンディション評価(1～5の5段階で)',value:'3.5\n補修あり'},{name:'⚫︎販売開始日',value:'2023/2/21 0:00'}];
 const mapped=mapZaicoOptionalAttributes(raw,true).extendedFields;
 assert.equal(mapped.height,raw[0].value);assert.equal(mapped.firstMarkdownPrice,'34,800');assert.equal(mapped.conditionRating,'3.5\n補修あり');assert.equal(mapped.saleStartDate,'2023-02-21');
 const headers=['物品名','カテゴリ','QRコード・バーコードの値','⚪︎高さ（cm）','⚪︎コンディション評価(1～5の5段階で)','⚫︎販売開始日'];
 const row=['照合テスト','販売中，業者間','0012345678901','77.5　アーム高さ65','3.5\n補修あり','2023/2/21 0:00'];
 const csvParsed=parseCsv(toCsv(headers,[row]));
 assert.equal(csvParsed[1][2],row[2]);assert.equal(csvParsed[1][4],row[4]);assert.deepEqual(splitCategoryNames(csvParsed[1][1]),['販売中','業者間']);
 const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('在庫');sheet.addRow(headers);sheet.addRow(row);const bytes=await book.xlsx.writeBuffer();const xlsx=await parseXlsxFile(bytes as ArrayBuffer);
 assert.deepEqual(xlsx.rows,[Object.fromEntries(headers.map((h,i)=>[h,csvParsed[1][i]]))]);
 console.log('PASS: six observed choice sets, legacy values, multiline, calendar validation, CSV/XLSX barcode/category/text preservation');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

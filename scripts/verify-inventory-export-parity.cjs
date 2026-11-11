// Execute the real CSV/XLSX export builder with anonymous, in-memory data sources.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),esbuild=require('esbuild');
const out=path.resolve('artifacts/inventory-parity-20261110');fs.mkdirSync(out,{recursive:true});
const data=`
const categories=[{id:'a',name:'販売中'},{id:'b',name:'確認'},{id:'c',name:'撮影待ち'}];
const rows=[
{id:'1',sku:'Q1',name:'アルペール 1',categoryIds:['a','b'],categoryId:'a',quantity:10,locationId:'L',statusId:'S'},
{id:'2',sku:'Q2',name:'arper 2',categoryIds:['b'],categoryId:'b',quantity:2,locationId:'L',statusId:'S'},
{id:'3',sku:'Q3',name:'arper 3',categoryIds:['a'],categoryId:'a',quantity:1,locationId:'L',statusId:'S'},
{id:'4',sku:'Q4',name:'テーブル',categoryIds:['b'],categoryId:'b',quantity:7,locationId:'L',statusId:'S'},
{id:'5',sku:'Q5',name:'arper 5',categoryIds:['b'],categoryId:'b',quantity:9,locationId:'L',statusId:'X'},
{id:'6',sku:'Q6',name:'arper 6',categoryIds:['b'],categoryId:'b',quantity:3,locationId:'X',statusId:'S'},
{id:'7',sku:'Q7',name:'削除済み',categoryIds:['b'],categoryId:'b',quantity:1,deletedAt:'2026-11-01'},
{id:'8',sku:'Q8',name:'旧形式',categoryId:'b',quantity:1},
].map(r=>({...r,customFields:JSON.stringify({stocktakeDate:'2026-11-11',groupTag:'倉庫確認'}),createdAt:'2026-11-10T00:00:00Z',updatedAt:'2026-11-10T00:00:00Z'}));
function match(r,f){return Object.entries(f).every(([k,v])=>k==='and'?v.every(x=>match(r,x)):k==='or'?v.some(x=>match(r,x)):Object.entries(v).every(([op,x])=>op==='eq'?r[k]===x:op==='ne'?r[k]!==x:op==='contains'?(r[k]??[]).includes(x):op==='attributeExists'?(r[k]!==undefined)===x:false));}
export const inventoryDdb={}; export const inventoryTable=()=> 'QA'; export const readInventoryBatch=async(db,table,ids)=>new Map(rows.filter(r=>ids.includes(r.id)).map(r=>[r.id,r]));
export const inventoryAuthMode={};
export const serverDataClient={models:{Inventory:{list:async({filter})=>({data:rows.filter(r=>match(r,filter)),nextToken:null})}}};
export const listCategories=async()=>categories;
export const listLocations=async()=>[{id:'L',name:'所沢事務所'}];
export const listStatuses=async()=>[{id:'S',label:'有効'}];
export const listCustomFieldDefinitions=async()=>[];
`;
async function main(){
 const file=path.join(out,'export-test.cjs');
 await esbuild.build({entryPoints:['lib/inventory/inventoryExport.ts'],bundle:true,platform:'node',format:'cjs',outfile:file,packages:'external',plugins:[{name:'isolated-sources',setup(b){
 b.onResolve({filter:/^(server-only|@\/lib\/amplify\/dataClient|\.\/queries|\.\/batchRead|\.\/categoryPersistence)$/},a=>({path:a.path,namespace:'qa'}));
 b.onResolve({filter:/mergeInventory$/},()=>({path:'merge',namespace:'qa'}));
 b.onLoad({filter:/.*/,namespace:'qa'},a=>({contents:a.path==='server-only'?'':a.path==='merge'?"export const NOT_MERGED_FILTER={mergedIntoId:{attributeExists:false}};":data,loader:'ts'}));
 }}]});
 const {buildInventoryExport}=require(file),ExcelJS=require('exceljs');
 const query={combinator:'AND',conditions:[{id:'q',field:'quantity',operator:'ge',value:'2'}]},fieldsByKey=new Map([['quantity',{key:'quantity',valueType:'number'}]]);
 const filters={q:'あるペール',categoryIds:['b'],locationId:'L',statusId:'S'},sort={field:'quantity',direction:'asc'};
 const csv=await buildInventoryExport('csv',filters,{query,fieldsByKey},sort),text=csv.buffer.toString('utf8');
 assert(text.includes('arper 2'));assert(text.includes('アルペール 1'));for(const name of ['arper 3','テーブル','arper 5','arper 6','削除済み'])assert(!text.includes(name));
 assert(text.indexOf('arper 2')<text.indexOf('アルペール 1'));assert(text.includes('販売中,確認'));
 const excel=await buildInventoryExport('xlsx',filters,{query,fieldsByKey},sort),book=new ExcelJS.Workbook();await book.xlsx.load(excel.buffer);const sheet=book.worksheets[0];assert.equal(sheet.rowCount,3);
 const header=sheet.getRow(1).values;const catColumn=header.indexOf('カテゴリ');assert(catColumn>0);assert.equal(sheet.getRow(3).getCell(catColumn).value,'販売中,確認');
 assert(text.includes('2026/11/11'));assert(text.includes('倉庫確認'));
 assert.equal(sheet.getRow(2).getCell(header.indexOf('棚卸日')).value,'2026/11/11');assert.equal(sheet.getRow(2).getCell(header.indexOf('グループタグ')).value,'倉庫確認');
 const legacy=(await buildInventoryExport('csv',{categoryIds:['b']})).buffer.toString('utf8');assert(legacy.includes('旧形式'));assert(!legacy.includes('削除済み'));
 const selected=(await buildInventoryExport('csv',{},undefined,undefined,['2','4'])).buffer.toString('utf8');assert(selected.includes('arper 2'));assert(selected.includes('テーブル'));assert(!selected.includes('アルペール 1'));
 for(const ids of [[],['missing'],['7'],['2','2']])await assert.rejects(buildInventoryExport('csv',{},undefined,undefined,ids));
 fs.writeFileSync(path.join(out,'export-tests.json'),JSON.stringify({at:new Date().toISOString(),passed:16,checks:['CSV棚卸日','CSVグループタグ','XLSX棚卸日','XLSXグループタグ','2番目のカテゴリで検索','検索・詳細条件・保管場所・状態のAND','日本語ブランド同義語','数値順の全件ソート','CSVの全カテゴリ','Excelの全カテゴリと行数','旧単一カテゴリと削除除外','選択IDだけをCSV出力','空選択拒否','欠落ID拒否','削除ID拒否','重複ID拒否']},null,2));
 console.log('PASS export parity: 16 checks, real CSV and XLSX builders, no AWS access');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

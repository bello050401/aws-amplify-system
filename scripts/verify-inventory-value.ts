import assert from 'node:assert/strict';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {buildInventoryValue,parseInventoryValue,donutSegments,INVENTORY_VALUE_REFERENCES,type ValueSource} from '../lib/inventory/inventoryValue';
const cats=['補修待ち','撮影待ち','出品待ち','販売中','川越移動予定','売り切れ','発送完了','入金待ち','事務所備品','保留'].map((name,i)=>({id:String(i),name}));
const r=(id:string,extra:Partial<ValueSource>={}):ValueSource=>({id,quantity:2,purchasePrice:1000,categoryIds:['3'],...extra});
let cases=0;
function test(name:string,run:()=>void){run();cases++;console.log('PASS',name);}
const calc=(rows:ValueSource[])=>buildInventoryValue(rows,cats,'2026-11-13T08:00:00.000Z');
test('unit cost × quantity; round-trip and all groups sum',()=>{const v=calc([r('a'),r('b',{quantity:3,purchasePrice:1188,categoryIds:['0']})]);assert.equal(v.total,5564);assert.equal(v.quantity,5);assert.deepEqual(parseInventoryValue(JSON.stringify(v)),v);assert.equal(donutSegments(v.groups).reduce((n,g)=>n+g.length,0),100);});
test('multiple categories, duplicate IDs and stale legacy category do not double count',()=>{const v=calc([r('a',{categoryIds:['3','4','3'],categoryId:'0'})]);assert.equal(v.total,2000);assert.equal(v.groups[3].amount,2000);assert.equal(v.groups[0].amount,0);});
test('legacy category and explicit empty array distinguished',()=>{const v=calc([r('a',{categoryIds:undefined,categoryId:'0'}),r('b',{categoryIds:[],categoryId:'3'})]);assert.equal(v.groups[0].amount,2000);assert.equal(v.groups[4].amount,2000);});
test('sold retained quantity, shipment, equipment and deleted record excluded',()=>{assert.equal(calc([r('a',{categoryIds:['5']}),r('b',{categoryIds:['6']}),r('c',{categoryIds:['8']}),r('d',{deletedAt:'2026-01-01'})]).total,0);});
test('unpaid stays inventory, paid leaves; active/date contradiction surfaced',()=>{const v=calc([r('a',{categoryIds:['5','7']}),r('b',{saleEndDate:'2026-11-13'})]);assert.equal(v.total,2000);assert.equal(v.other[0].label,'入金待ち');assert.equal(v.issueCount,1);});
test('split inventory adds remaining units, not sold child',()=>{assert.equal(calc([r('parent',{quantity:3}),r('child',{quantity:1,categoryIds:['5'],saleEndDate:'2026-11-13'})]).total,3000);});
test('zero cost is valid, absent cost is missing, zero quantity has no contribution',()=>{const v=calc([r('a',{purchasePrice:0}),r('b',{purchasePrice:null}),r('c',{quantity:0})]);assert.equal(v.total,0);assert.equal(v.unpricedCount,1);assert.equal(v.quantity,4);assert.equal(v.count,2);});
test('invalid quantity and price do not poison totals',()=>{const v=calc([r('a',{quantity:-1}),r('b',{purchasePrice:-1}),r('c',{quantity:1.5})]);assert.equal(v.total,0);assert.equal(v.issueCount,3);});
test('conflicting workflow statuses are counted once in other',()=>{const v=calc([r('a',{categoryIds:['0','3']})]);assert.equal(v.total,2000);assert.equal(v.groups[4].amount,2000);assert.equal(v.issueCount,1);});
test('no freight double addition',()=>{assert.equal(calc([{...r('a'),shippingCost:500} as ValueSource]).total,2000);});
test('duplicate inventory IDs and numeric overflow fail closed',()=>{assert.throws(()=>calc([r('a'),r('a')]));assert.throws(()=>calc([r('a',{purchasePrice:Number.MAX_SAFE_INTEGER})]));});
test('corrupt snapshot and total/group mismatch rejected',()=>{assert.throws(()=>parseInventoryValue('null'));assert.throws(()=>parseInventoryValue(JSON.stringify({...calc([r('a')]),total:1})));});
test('blank October workbook cell is not a zero reference',()=>{assert.equal(INVENTORY_VALUE_REFERENCES.find(([m])=>String(m)==='2026-10'),undefined);assert.equal(INVENTORY_VALUE_REFERENCES.at(-1)?.[1],11516163);});
test('bounded issue detail in incomplete 10x inventory',()=>{const v=calc(Array.from({length:57000},(_,i)=>r(String(i),{purchasePrice:null,name:'長い商品名'.repeat(100)})));assert.equal(v.issueCount,57000);assert.equal(v.issues.length,50);assert.ok(Buffer.byteLength(JSON.stringify(v))<70000);});
const bench=Array.from({length:5700},(_,i)=>r(String(i),{categoryIds:[String(i%4)],purchasePrice:i+1000}));
const times=Array.from({length:1000},()=>{const t=performance.now();calc(bench);return performance.now()-t;}).sort((a,b)=>a-b);
const perf={cases,rows:bench.length,runs:times.length,p50:times[499],p95:times[949],p99:times[989]};
fs.mkdirSync('artifacts/inventory-value',{recursive:true});fs.writeFileSync('artifacts/inventory-value/unit-results.json',JSON.stringify(perf,null,2));console.log(perf);
if(fs.existsSync('artifacts/inventory-source.json')){
 const live=JSON.parse(fs.readFileSync('artifacts/inventory-source.json','utf8'));
 const v=buildInventoryValue(live.rows,live.categories,new Date().toISOString());
 fs.writeFileSync('artifacts/inventory-value/audited-value.json',JSON.stringify(v,null,2));
 console.log(JSON.stringify({total:v.total,quantity:v.quantity,count:v.count,groups:v.groups,unpriced:v.unpricedCount,issues:v.issues.map(i=>({sku:i.sku,reason:i.reason}))},null,2));
}

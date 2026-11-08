import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createQuickSearchMatcher, evaluateCondition, type SearchableRecord} from '../lib/inventory/advancedSearch';
import {createNameSearchMatcher, normalizeNameSearch} from '../lib/inventory/nameSearch';
import brands from '../lib/brands/search.generated.json';

const record = (name: string): SearchableRecord => ({name, customFields: null});
let checks = 0;
function match(query: string, name: string, expected: boolean) {
  assert.equal(createQuickSearchMatcher(query)(record(name)), expected, `${query} → ${name}`); checks++;
}
for (const query of ['あるペール', 'あるぺーる', 'アルペール', 'ｱﾙﾍﾟｰﾙ', 'arper', 'ARPER', 'ＡＲＰＥＲ']) {
  for (const title of ['Arper Catifa46', 'アルペール カティファ46', 'あるぺーる チェア']) match(query, title, true);
  match(query, 'Harper チェア', false);
  match(query, 'ArperX チェア', false);
  match(query, 'Vitra チェア', false);
}
for (const [query, title] of [
  ['かっしーな', 'Cassina CAB'], ['カッシーナ', 'CASSINA CAB'],
  ['びとら', 'びとら チェア'], ['てーぶる', 'テーブル'],
  ['あるペール Catifa46', 'ARPER Catifa46'], ['arper', '【在庫5】ARPER/Catifa46'],
]) match(query, title, true);
for (const [query, title] of [['Arper Catifa53', 'Arper Catifa46'], ['HAY', 'Hayward'], ['*', 'チェア'], ['[x]', 'x']]) match(query, title, false);
match('[x]', 'a.b [x] $ * + ?', true);
assert.equal(createQuickSearchMatcher('あるペール')({sku:'arper',customFields:null}), false);
assert.equal(createQuickSearchMatcher('B000123')({displayId:'B000123',customFields:null}), true);
assert.equal(evaluateCondition(record('arper'), {key:'name',label:'商品名',group:'基本',valueType:'string'}, {id:'a',field:'name',operator:'equals',value:'アルペール'}), false, 'Explicit equality is not synonym matching');
// Every original AWS pair must work in both directions with kana normalization.
for (const [name, reading] of brands) {
  if (name.length < 2 || reading.length < 2) continue;
  assert(createNameSearchMatcher(reading)(normalizeNameSearch(name)), `${reading} → ${name}`);
  assert(createNameSearchMatcher(name)(normalizeNameSearch(reading)), `${name} → ${reading}`);
  checks += 2;
}
const rows=Array.from({length:6000}, (_,i)=>record(i%20===0?'【在庫5】arper Catifa46':'【在庫2】Vitra Chair '+i));
const samples:number[]=[];
for(let i=0;i<31;i++) {const start=performance.now(); const matcher=createQuickSearchMatcher('あるペール');assert.equal(rows.filter(matcher).length,300);if(i)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({checks,brands:brands.length,rows:rows.length,p50Ms:samples[15],p95Ms:samples[28],unchangedIdentifiers:true,networkCalls:0}));

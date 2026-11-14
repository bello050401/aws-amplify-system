import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryFromTitle, CATEGORY_COLORS } from './categoryFromTitle';
import { buildAnalysis } from './aggregate';
import { analysisFixtureWorkflow, fixtureAssignment, fixtureInventory, fixtureKind } from './fixtures';
import { queryAnalysis, drilldownAnalysis } from './query';
import { makeAnalysisManifest, parseAnalysisManifest } from './publicationFormat';
import { UNKNOWN, type Bucket, type MetadataRow } from './types';

const asOf = '2026-11-15T01:00:00.000Z';
const rows = [fixtureInventory('a', 2, 100, {name:'ダイニングチェア'}), fixtureInventory('b', 3, null, {name:'ラウンジチェア'}), fixtureInventory('c', 1, 0, {name:'テーブル'})];
const taxonomy = (categories: {id:string;label:string;mergedInto?:string}[]):MetadataRow => ({id:'taxonomy',revision:1,value:{type:'taxonomy',categories}});
const build = (metadata:MetadataRow[] = [], source=rows) => buildAnalysis(source,analysisFixtureWorkflow,metadata,asOf,asOf);

test('title rules use explicit item nouns and discard management/related-item notes', () => {
  const cases:[string,string|null][] = [
    ['【B&Bラウンジチェアとコード重複】ダイニングチェア / 関連:ソファ', 'dining-chair'],
    ['【在庫4】テーブルランプ 検:ダイニングチェア','lighting'],
    ['未使用品 ELUX SPINNER コードアジャスター','other'],
    ['テーブル ライトブラウン','table-desk'],
    ['ダイニングテーブル ダイニングチェア 5点セット',null],
    ['ソファ テーブル 2点セット',null],
    ['ソファ スツール セット',null],
    ['テーブルとベンチの2点セット',null],['ソファとテーブルランプのセット',null],
    ['ソファ＋チェアのセット',null],['収納棚とテーブルのセット',null],
    ['テーブルと花瓶のセット',null],['花瓶とテーブルランプのセット',null],
    ['照明とコートスタンドのセット',null],['ソファとマットレスのセット',null],
    ['Sofas and lamps set',null],['ラウンジチェアとオットマンと花瓶のセット',null],
    ['テーブルランプ 2点セット','lighting'],['デスクチェア 3点セット','work-chair'],
    ['ラウンジチェア オットマンセット','personal-chair'],
    ['シングルシートソファ ラウンジチェア',null],
    ['Vitra ワークチェア デスクチェア パーソナルチェア','work-chair'],
    ['ダイニングチェア ワークチェア','chair-unspecified'],
    ['チェア ホワイト','chair-unspecified'],
    ['【脚のみ：在庫4】Catifa 53 アームレスチェア','other'],
    ['【在庫2】サイドテーブル 関連：ワークチェア','table-desk'],
    ['スツール','stool'],['ベンチ','bench-ottoman'],['木製書棚','storage'],
    ['抽象画 ポスター','interior-art'],['パーテーション','other'],['カラーウッド ダークグリッド',null],
  ];
  for (const [title,expected] of cases) assert.equal(categoryFromTitle(title),expected,title);
});

test('category derivation preserves source records, zero vs unknown, totals and sales facts', async () => {
  const source=[...rows,fixtureInventory('sold',0,20,{name:'ソファ',saleEndDate:'2026-11-14',salePrice:500,categoryId:'sold'})];
  const snapshot=JSON.stringify(source),model=build([],source),result=queryAnalysis(model,{target:'inventory'});
  assert.equal(JSON.stringify(source),snapshot);assert.equal(result.status,'ok');if(result.status!=='ok')throw Error();
  assert.deepEqual([result.summary.amount,result.summary.quantity,result.summary.kinds,result.summary.unknown.cost],[200,6,0,1]);
  assert.equal(model.sales[0].category,UNKNOWN);assert.equal(model.sales[0].amount,500);
  for(const dimension of ['category','holdingCount'] as const){
    const buckets:Bucket[]=result.summary.dimensions[dimension]!;
    assert.equal(buckets.reduce((s,b)=>s+b.amount,0),200);assert.equal(buckets.reduce((s,b)=>s+b.quantity,0),6);
    for(const bucket of buckets){const details=await drilldownAnalysis(model,{target:'inventory',generation:asOf,dimension,key:bucket.key});assert.equal(details.status,'ok');}
  }
  assert.equal(result.summary.dimensions.category?.find(b=>b.key==='dining-chair')?.color,CATEGORY_COLORS['dining-chair']);
  assert.ok(model.inventory.every(f=>f.categoryBasis==='title'&&f.kindId===null&&f.unknown.kind===1));
  const zero=model.inventory.find(f=>f.id==='c')!,missing=model.inventory.find(f=>f.id==='b')!;
  assert.equal(zero.amount,0);assert.equal(missing.amount,null);
});

test('confirmed overrides, renamed categories and merged targets are preserved', () => {
  const manual=fixtureAssignment('a',null,{categoryId:'sofa',categoryState:'confirmed'});
  const model=build([taxonomy([{id:'sofa',label:'ソファ確認済'},{id:'dining-chair',label:'ダイニング用'}]),manual]);
  assert.equal(model.inventory[0].category,'sofa');assert.equal(model.inventory[0].categoryBasis,'confirmed');
  const renamed=build([taxonomy([{id:'dining-chair',label:'ダイニング用'}])]);
  assert.equal(renamed.inventory[0].category,'dining-chair');
  const merged=build([taxonomy([{id:'dining-chair',label:'ダイニング',mergedInto:'chairs'},{id:'chairs',label:'椅子'}])]);
  assert.equal(merged.inventory[0].category,'chairs');assert.equal(merged.categories.filter(c=>c.id==='dining-chair').length,0);
});

test('unclassified confirmed kinds cannot be split by conflicting title guesses', () => {
  const model=build([fixtureKind('same',null),fixtureAssignment('a','same'),fixtureAssignment('b','same')]);
  const result=queryAnalysis(model,{target:'inventory'});assert.equal(result.status,'ok');if(result.status!=='ok')throw Error();
  assert.equal(result.summary.kinds,1);
  assert.equal(result.summary.dimensions.category?.reduce((s,b)=>s+b.kinds,0),1);
  assert.deepEqual(model.inventory.filter(f=>f.kindId==='same').map(f=>f.category),[UNKNOWN,UNKNOWN]);
  assert.deepEqual(model.inventory.filter(f=>f.kindId==='same').map(f=>f.holdingCount),[5,5]);
});

test('maximum manual taxonomy remains readable by the previous 100-category reader', () => {
  const model=build([taxonomy(Array.from({length:100},(_,i)=>({id:'manual-'+i,label:'用途'+i})))]);
  const {manifest}=makeAnalysisManifest(model);assert.equal(manifest.header.categories.length,100);
  assert.ok(model.inventory.every(row=>row.category===UNKNOWN));
  assert.deepEqual(parseAnalysisManifest(JSON.stringify(manifest),asOf),manifest);
});

test('derived taxonomy capacity is independent of inventory scan order', () => {
  const metadata=[taxonomy(Array.from({length:99},(_,i)=>({id:'manual-'+i,label:'用途'+i})))];
  const forward=build(metadata),reverse=build(metadata,[...rows].reverse());
  assert.deepEqual(forward.categories,reverse.categories);
  assert.deepEqual(forward.inventory.map(f=>[f.id,f.category]).sort(),reverse.inventory.map(f=>[f.id,f.category]).sort());
});

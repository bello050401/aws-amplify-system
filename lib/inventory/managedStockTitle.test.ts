import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importedStockTitle,managedStockTitleChange,managedTitleBase,STOCK_TITLE_META} from './managedStockTitle';

const product='【業者間】A-3 ダイニングチェア トーネット S320';
function fixture(){
 const created=importedStockTitle(product,1,'脚','RESTAGE');
 return {name:'【在庫3】12/2【在庫3】'+product,quantity:3,unit:'脚',purchasePrice:3564,
  customFields:JSON.stringify({memo:'残すメモ',[STOCK_TITLE_META]:{...created.metadata,prefix:'【在庫3】',baseName:'12/2【在庫3】'+product,lastQuantity:3}})};
}
const metadata=(row:Record<string,unknown>)=>JSON.parse(String(row.customFields))[STOCK_TITLE_META];

test('reported date-separated duplicate is repaired without changing actual quantity or procurement provenance',()=>{
 const source=fixture(),patch=managedStockTitleChange({name:source.name},source),row={...source,...patch};
 assert.equal(row.name,'【在庫3】12/2'+product);
 assert.equal(row.quantity,3);assert.equal(row.unit,'脚');assert.equal(row.purchasePrice,3564);
 assert.equal(metadata(row).sourceQuantity,1);assert.equal(metadata(row).source,'RESTAGE');
 assert.equal(JSON.parse(String(row.customFields)).memo,'残すメモ');
 assert.equal(source.name,'【在庫3】12/2【在庫3】'+product);
});
test('repeated saves of the corrected title are idempotent',()=>{
 let row:Record<string,unknown>=fixture();
 row={...row,...managedStockTitleChange({name:row.name},row)};
 const expected=structuredClone(row);
 for(let n=0;n<10;n++){row={...row,...managedStockTitleChange({name:row.name},row)};assert.deepEqual(row,expected);}
});
test('prepending dates and notes before the generated marker never adds a second marker',()=>{
 const source=fixture();
 for(const name of ['12/8【在庫3】'+product,'【引渡予定】12/8【在庫3】'+product,'【在庫3】12/8【在庫3】【在庫3】'+product]){
  const row=managedStockTitleChange({name},source);
  assert.equal(row.name,'【在庫3】'+name.replace(/【在庫3】/g,''));
 }
});
test('stale automatic counts follow explicit quantity changes and disappear for zero or one',()=>{
 let row:Record<string,unknown>=fixture();
 for(const quantity of [2,1,0,3]){
  row={...row,...managedStockTitleChange({quantity},row)};
  assert.equal(row.name,(quantity>=2?`【在庫${quantity}】`:'')+'12/2'+product);
  assert.equal(row.quantity,quantity);assert.equal(metadata(row).lastQuantity,quantity);
  assert.equal(metadata(row).sourceQuantity,1);
 }
});
test('human compound notes, set sizes, and nested stock text remain byte-for-byte intact',()=>{
 const note='【座面：在庫3脚・補修】【補修【在庫3】】【3脚セット】幅53cm';
 const source=fixture(),row=managedStockTitleChange({name:'12/2【在庫3】'+note+product},source);
 assert.equal(row.name,'【在庫3】12/2'+note+product);
});
test('only exact generated count syntax is normalized',()=>{
 const note='【在庫：3】【在庫３】【在庫3脚】【在庫3以上】';
 assert.equal(managedStockTitleChange({name:'【在庫3】'+note+product},fixture()).name,'【在庫3】'+note+product);
});
test('unmanaged or invalid-version titles are not rewritten',()=>{
 const source=fixture(),input={name:source.name,quantity:2};
 for(const customFields of ['{}',JSON.stringify({[STOCK_TITLE_META]:{version:2,prefix:'【在庫3】',baseName:product}}),JSON.stringify({[STOCK_TITLE_META]:{version:1,prefix:'【在庫3】'}})]){
  assert.deepEqual(managedStockTitleChange(input,{...source,customFields}),input);
  assert.equal(managedTitleBase(source.name,{customFields}),source.name);
 }
});
test('sale preparation removes moved managed markers while retaining dates and product notes',()=>{
 const source=fixture();assert.equal(managedTitleBase(source.name,source),'12/2'+product);
 assert.equal(managedTitleBase('12/8'+source.name,source),'12/812/2'+product);
});
test('managed sold channels survive date prepends and quantity changes including legacy metadata',()=>{
 for(const channel of ['【BASE】','【ヤフオク】','【メルカリショップ】'])for(const legacy of [false,true]){
  const source=fixture(),meta=metadata(source);
  source.name='12/2'+channel+'【在庫3】'+product;
  source.customFields=JSON.stringify({[STOCK_TITLE_META]:{...meta,prefix:channel+'【在庫3】',...(legacy?{}:{salePrefix:channel})}});
  const changed=managedStockTitleChange({name:source.name,quantity:2},source);
  assert.equal(changed.name,channel+'【在庫2】12/2'+product);
  assert.equal(managedStockTitleChange({quantity:1},{...source,...changed}).name,channel+'12/2'+product);
 }
});
test('nested sold-channel note is preserved before the real moved channel marker',()=>{
 for(const channel of ['【BASE】','【ヤフオク】','【メルカリショップ】']){
  const source=fixture(),meta=metadata(source),note='【注記'+channel+'】';
  source.name=note+'12/2'+channel+'【在庫3】'+product;
  source.customFields=JSON.stringify({[STOCK_TITLE_META]:{...meta,salePrefix:channel,prefix:channel+'【在庫3】'}});
  const changed=managedStockTitleChange({name:source.name,quantity:2},source);
  assert.equal(changed.name,channel+'【在庫2】'+note+'12/2'+product);
  assert.equal(managedTitleBase(source.name,source),note+'12/2'+product);
  assert.equal(managedStockTitleChange({...changed},{...source,...changed}).name,changed.name);
 }
});
test('saved input metadata can be normalized without a current row',()=>{
 const source=fixture();assert.equal(managedStockTitleChange(source).name,'【在庫3】12/2'+product);
});
test('missing or invalid quantities remain errors and are never inferred from a title',()=>{
 for(const quantity of [null,undefined,-1,1.5,'3',NaN])assert.throws(()=>managedStockTitleChange({name:'【在庫3】'+product},{...fixture(),quantity}));
});

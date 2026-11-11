import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {defaultInventoryView,sanitizeInventoryView,orderedVisibleOptions} from '../lib/inventory/viewPreferences';
import {transformInventoryEdit,validateEditRules} from '../lib/inventory/editTransform';
import {importedStockTitle,STOCK_TITLE_META} from '../lib/inventory/managedStockTitle';
import {inventoryDiff,applyInventoryDiff,recordInventorySave,moveInventoryHistory} from '../lib/inventory/reversibleHistory';
import {hasInventoryEditDraft} from '../lib/inventory/editDraft';
const results:string[]=[];
function test(name:string,fn:()=>void){fn();results.push(name);console.log('PASS '+name);}
const keep={categories:{mode:'keep' as const},names:[]};
test('通常項目だけ・0・空欄化も未保存として保護し、変更なしは警告しない',()=>{
 assert.equal(hasInventoryEditDraft(keep),false);
 assert.equal(hasInventoryEditDraft({...keep,fields:{},customFieldChanges:{},location:{mode:'keep'}}),false);
 for(const fields of [{quantity:0},{width:'71.5'},{salePrice:0},{note:null}])assert.equal(hasInventoryEditDraft({...keep,fields}),true);
 assert.equal(hasInventoryEditDraft({...keep,location:{mode:'clear'}}),true);
 assert.equal(hasInventoryEditDraft({...keep,categories:{mode:'clear'}}),true);
 assert.equal(hasInventoryEditDraft({...keep,customFieldChanges:{memo:null}}),true);
});
test('表示設定の不正値・重複・容量上限',()=>{
 assert.deepEqual(sanitizeInventoryView(null),defaultInventoryView());
 const v=sanitizeInventoryView({pinFirstColumn:'true',keepSelection:true,categoryPlacement:'unknown',hiddenCategories:['a','a',5,''],detailOrder:Array.from({length:2000},(_,i)=>String(i))});
 assert.equal(v.pinFirstColumn,false);assert.equal(v.keepSelection,true);assert.equal(v.categoryPlacement,'column');assert.deepEqual(v.hiddenCategories,['a']);assert.equal(v.detailOrder.length,1000);
});
test('非表示・並び順・絞り込み中の項目を隠さない',()=>{
 const items=[{id:'a'},{id:'b'},{id:'c'},{id:'new'}];
 assert.deepEqual(orderedVisibleOptions(items,['c','a'],['b']).map(v=>v.id),['c','a','new']);
 assert.deepEqual(orderedVisibleOptions(items,['c','a'],['b'],['b']).map(v=>v.id),['c','a','b','new']);
 assert.deepEqual(items.map(v=>v.id),['a','b','c','new']);
});
test('一括の通常項目を変えても未指定項目とカテゴリを維持',()=>{
 const before={name:'チェア',categoryIds:['a','b'],quantity:5,note:'元メモ',width:'60',locationId:'L1',salePrice:1000};
 const out=transformInventoryEdit(before,{...keep,fields:{quantity:2,note:'改行\n保持',width:'71.5',plannedSalePrice:22800}});
 const after={...before,...out.after};assert.equal(after.quantity,2);assert.equal(after.salePrice,1000);assert.equal(after.locationId,'L1');assert.deepEqual(after.categoryIds,['a','b']);assert.equal(out.changed,true);
 const changed=recordInventorySave(before,after,{id:'qa-history',operationId:'qa',actor:'QA',source:'bulk',at:new Date().toISOString()});
 const undone=moveInventoryHistory(changed.row,'undo').row,redone=moveInventoryHistory(undone,'redo').row;
 assert.equal(undone.quantity,5);assert.equal(undone.note,'元メモ');assert.equal(redone.width,'71.5');assert.equal(redone.quantity,2);
});
test('許可外・不正金額・日付・数量はプレビュー前に拒否',()=>{
 for(const fields of [{id:'overwrite'},{name:'wrong route'},{categoryIds:['x']},{locationId:'x'},{customFields:{}},{quantity:-1},{quantity:'2'},{salePrice:NaN},{saleEndDate:'2026-02-30'},{customFieldChanges:{x:1}}])assert.throws(()=>validateEditRules({...keep,fields}));
 validateEditRules({...keep,fields:{note:null,salePrice:0,width:'約71.5',saleEndDate:'2026-11-11'}});
});
test('自動在庫タイトルは数量と一致、社内メモは保護、空数量は拒否',()=>{
 const title=importedStockTitle('チェア',5,'脚','qa'),before={name:title.name,quantity:5,categoryIds:['a'],customFields:JSON.stringify({[STOCK_TITLE_META]:title.metadata,memo:'残す'})};
 const out=transformInventoryEdit(before,{...keep,fields:{quantity:2}});
 assert.equal(out.after.name,'【在庫2】チェア');assert.equal(JSON.parse(String(out.after.customFields)).memo,'残す');
 assert.equal(transformInventoryEdit(before,keep).changed,false);
 assert.throws(()=>transformInventoryEdit(before,{...keep,fields:{quantity:null}}));
 const human={...before,name:'【在庫5】手動メモ',customFields:'{}'};
 assert.equal(transformInventoryEdit(human,{...keep,fields:{quantity:2}}).after.name,human.name);
 const after={...before,...out.after},delta=inventoryDiff(before,after);
 assert.equal(applyInventoryDiff(applyInventoryDiff(before,delta,'redo'),delta,'undo').name,before.name);
});
mkdirSync('artifacts/zaico-settings-20261111',{recursive:true});
writeFileSync('artifacts/zaico-settings-20261111/unit-results.json',JSON.stringify({at:new Date().toISOString(),passed:results.length,results},null,2));

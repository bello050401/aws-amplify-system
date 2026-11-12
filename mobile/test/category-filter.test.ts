import test from 'node:test';
import assert from 'node:assert/strict';
import {quickCategoryValues,validCategoryChoices,withFilterCategories} from '../src/domain/categoryFilter';
import {buildSearchFieldDefs} from '../../lib/inventory/advancedSearch';
import {QuickSearchCatalog} from '../src/domain/quickSearch';
import {previewItems} from '../src/preview/fixture';
const choices=[{value:'repair',label:'補修待ち'},{value:'photo',label:'撮影待ち'},{value:'listed',label:'販売中'},{value:'check',label:'市川確認'}];
const fields=buildSearchFieldDefs([],{categories:[],locations:[],statuses:[]});

test('category-only recovery fills empty masters without changing other fields',()=>{
 const recovered=withFilterCategories(fields,choices);
 assert.deepEqual(recovered.find(f=>f.key==='categoryId')!.options,choices);
 for(const field of fields.filter(f=>f.key!=='categoryId'))assert.equal(recovered.find(f=>f.key===field.key),field);
 assert.equal(withFilterCategories(fields,null),fields);
});
test('quick buttons only use real master IDs, preserve duplicate names and order common categories',()=>{
 const input=[choices[3],choices[2],choices[1],choices[0],{value:'another-repair',label:'補修待ち'}];
 assert.deepEqual(quickCategoryValues(input),['repair','another-repair','photo','listed']);
 assert.ok(validCategoryChoices(input));
 for(const input of [null,{},[{value:'',label:'補修待ち'}],[{value:'a',label:''}],[choices[0],choices[0]]])assert.equal(validCategoryChoices(input),false);
});
test('one category, multiple OR categories, clearing and combined name search return correct inventory',()=>{
 const c=new QuickSearchCatalog();
 c.replace([
  {...previewItems[0],id:'a',category:'補修待ち,市川確認',name:'アルペール チェア'},
  {...previewItems[1],id:'b',category:'撮影待ち',name:'テーブル'},
  {...previewItems[2],id:'c',category:'販売中',name:'チェア'},
 ],0);
 const recovered=withFilterCategories(fields,choices);
 assert.deepEqual(c.search({categoryIds:['repair']},recovered)!.items.map(i=>i.id),['a']);
 assert.equal(c.search({categoryIds:['repair','photo']},recovered)!.total,2);
 assert.equal(c.search({categoryIds:[]},recovered)!.total,3);
 assert.equal(c.search({q:'テーブル',categoryIds:['repair','photo']},recovered)!.total,1);
 assert.equal(c.search({categoryIds:['補修待ち']},recovered),null,'labels must not be sent as IDs');
});
test('ambiguous labels still fall back to authoritative search',()=>{
 const c=new QuickSearchCatalog();c.replace([{...previewItems[0],category:'補修待ち'}],0);
 assert.equal(c.search({categoryIds:['repair']},withFilterCategories(fields,[...choices,{value:'other',label:'補修待ち'}])),null);
});

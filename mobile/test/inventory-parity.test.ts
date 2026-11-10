import test from 'node:test';
import assert from 'node:assert/strict';
import {QuickSearchCatalog} from '../src/domain/quickSearch';
import {ListPreferences} from '../src/domain/listPreferences';
import {buildSearchFieldDefs,evaluateQuery,type AdvancedSearchCondition,type AdvancedSearchQuery} from '../../lib/inventory/advancedSearch';
import {inventoryComparator} from '../../lib/inventory/searchSort';
import {searchValidation} from '../src/domain/search';
import {previewItems} from '../src/preview/fixture';
const fields=buildSearchFieldDefs([],{categories:[{id:'c1',name:'販売中'},{id:'c2',name:'市川確認'}],locations:[{id:'l1',name:'所沢事務所'}],statuses:[]});
const defs=new Map(fields.map(f=>[f.key,f]));
const data=Array.from({length:127},(_,i)=>({...previewItems[0],id:'item-'+i,displayId:String(7000+i),sku:'B'+i,
 name:i%2?'arper チェア':'アルペール テーブル',category:i%3===0?'販売中,市川確認':i%3===1?'販売中':'',
 location:i%2?'所沢事務所':'',quantity:i%5,quantityUnset:i%7===0,plannedSalePrice:i%3?i*100:null,
 createdAt:'2026-11-01T15:00:00Z',updatedAt:'2026-11-02T00:00:00Z',listUpdatedAt:i%2?'2026-11-03T15:00:00Z':'2026-11-02T01:00:00Z'}));
const catalog=new QuickSearchCatalog();catalog.replace(data,0);
const canonical=data.map(i=>({...i,categoryId:i.category?'c1':null,
 categoryIds:i.category==='販売中,市川確認'?['c1','c2']:i.category?['c1']:[],locationId:i.location?'l1':null,sourceInventoryId:i.displayId,customFields:null}));
function all(query:AdvancedSearchQuery,sort={field:'updatedAt',direction:'desc' as const}){
 const ids:string[]=[];let offset=0;
 for(;;){const p=catalog.search({advanced:query,sort,offset},fields);assert.ok(p);ids.push(...p.items.map(i=>i.id));if(!p.hasMore)return ids;offset=p.nextOffset;}
}
test('compact and server search agree for all basic operators, AND/OR, stable pagination',()=>{
 const cases:AdvancedSearchCondition[]=[
  ...(['anyOf','allOf','noneOf'] as const).map(operator=>({id:operator,field:'categoryId',operator,values:['c1','c2']})),
  {id:'legacy',field:'categoryId',operator:'equals',value:'c2'},
  {id:'empty',field:'categoryId',operator:'isEmpty'},
  {id:'location',field:'locationId',operator:'equals',value:'l1'},
  ...(['eq','gt','ge','lt','le'] as const).map(operator=>({id:operator,field:'quantity',operator,value:'2'})),
  {id:'qtyblank',field:'quantity',operator:'isEmpty'},
  {id:'price',field:'plannedSalePrice',operator:'between',value:'300',value2:'10000'},
  {id:'date',field:'updatedAt',operator:'on',value:'2026-11-04'},
  {id:'name',field:'name',operator:'contains',value:'あるぺーる'},
  {id:'barcode',field:'barcode',operator:'equals',value:'PREVIEW001'},
 ];
 for(const c of cases)for(const combinator of ['AND','OR'] as const){
  const query={combinator,conditions:[c,{id:'other',field:'quantity',operator:'eq' as const,value:'1'}]};
  assert.equal(searchValidation(query,fields),null);
  const expected=canonical.filter(r=>evaluateQuery(r,query,defs)).sort(inventoryComparator({field:'updatedAt',direction:'desc'},defs)).map(r=>r.id);
  assert.deepEqual(all(query),expected,JSON.stringify(query));
 }
});
test('category selections use IDs and retain all selected categories',()=>{
 const p=catalog.search({categoryIds:['c2']},fields)!;assert.equal(p.total,43);assert.ok(p.items.every(i=>i.category.includes('市川確認')));
 for(const values of [[],['missing'],[4]])assert.ok(searchValidation({combinator:'AND',conditions:[{id:'c',field:'categoryId',operator:'allOf',values:values as string[]}]},fields));
});
test('unknown/unfetched/restricted fields and invalid conditions are never handled as blank locally',()=>{
 for(const field of ['note','salePrice','cf:damageNotes','not-a-field'])assert.equal(catalog.search({advanced:{combinator:'AND',conditions:[{id:'c',field,operator:'isEmpty'}]}},fields),null);
 assert.equal(catalog.search({advanced:{combinator:'AND',conditions:[{id:'c',field:'quantity',operator:'eq',value:'no'}]}},fields),null);
 const ambiguous=fields.map(f=>f.key==='categoryId'?{...f,options:[...f.options!,{value:'other',label:'販売中'}]}:f);
 assert.equal(catalog.search({categoryIds:['c1']},ambiguous),null);
 assert.equal(catalog.search({categoryIds:['missing']},fields),null);
});
test('edits and deletions invalidate the cached filter; new versions do not leave a stale row',()=>{
 const c=new QuickSearchCatalog();c.replace(data,0);
 assert.equal(c.search({categoryIds:['c2']},fields)!.total,43);
 c.update([{...data[0],category:'',updatedAt:'2026-11-05T00:00:00Z'}],[data[3].id]);
 assert.equal(c.search({categoryIds:['c2']},fields)!.total,41);
});
test('sort preference survives reconstruction, isolates accounts and rejects malformed data',async()=>{
 const rows=new Map<string,string>(),store={getItem:async(k:string)=>rows.get(k)??null,setItem:async(k:string,v:string)=>{rows.set(k,v);}};
 const a=new ListPreferences(store,'a','https://example.test');await a.write({field:'quantity',direction:'asc'});
 assert.deepEqual(await new ListPreferences(store,'a','https://example.test').read(),{field:'quantity',direction:'asc'});
 assert.equal(await new ListPreferences(store,'b','https://example.test').read(),null);
 assert.equal(await new ListPreferences(store,'a','https://another.test').read(),null);
 rows.set([...rows.keys()][0],'{oops');assert.equal(await a.read(),null);
});

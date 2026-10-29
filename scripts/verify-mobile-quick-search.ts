import assert from 'node:assert/strict';
import {QuickSearchCatalog,QUICK_SEARCH_MAX_AGE,supportsQuickSearch} from '../mobile/src/domain/quickSearch';
import {cachedInventorySearch,cachedSearchFields} from '../mobile/src/domain/search';
import {RESTRICTED_FEATURES} from '../mobile/src/domain/access';
import type {InventoryItem} from '../mobile/src/domain/inventory';
import {build} from 'esbuild';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {compactCatalogItem} from '../mobile/src/domain/catalogProtocol';
async function main(){
 const rows:InventoryItem[]=Array.from({length:6000},(_,n)=>({id:String(n),sku:'B'+n,displayId:String(n),name:n===5999?'【在庫2】Cassina カッシーナ チェア':'確認商品 '+n,
  quantity:n%7,unit:'点',location:'所沢事務所',category:n%2?'補修待ち,椅子':'撮影待ち',condition:'',note:'',barcode:'2026'+n,plannedSalePrice:n%2?null:1000,
  createdAt:'2026-01-01',updatedAt:'2026-10-29',thumbnailUrl:null}));
 const fields=cachedSearchFields(rows,RESTRICTED_FEATURES),c=new QuickSearchCatalog(),now=1000;
 assert.equal(c.search({q:'チェア'},fields,now),null);
 assert.equal(c.replace(rows,c.version(),now),true);
 for(const q of ['チェア','ＣＡＳＳＩＮＡ','確認 商品','見つからない']){
  for(const direction of ['asc','desc'] as const){
   const input={q,sort:{field:'updatedAt',direction}};
   const expected=cachedInventorySearch(rows,input,fields),actual=c.search(input,fields,now)!;
   assert.deepEqual(actual.items,expected.slice(0,50).map(compactCatalogItem));assert.equal(actual.total,expected.length);
   assert.equal(actual.totalQuantity,expected.reduce((s,r)=>s+r.quantity,0));
  }
 }
 assert.equal(c.search({q:'チェア'},fields,now)!.items[0].id,'5999');
 assert.equal(c.search({category:'補修待ち',offset:50},fields,now)!.items.length,50);
 assert.equal(c.search({q:'チェア'},fields,now+QUICK_SEARCH_MAX_AGE),null);
 assert.equal(supportsQuickSearch({q:'a',advanced:{combinator:'AND',conditions:[{id:'a',field:'note',operator:'contains',value:'x'}]}}),false);
 assert.equal(supportsQuickSearch({q:'a',sort:{field:'cf:market',direction:'asc'}}),false);
 const old=c.version();c.update([],['5999']);assert.equal(c.replace(rows,old,now),false);assert.equal(c.search({q:'チェア'},fields,now)!.total,0);
 c.update([{...rows[5999],name:'更新後のタイトル',quantity:1}]);assert.equal(c.search({q:'更新後'},fields,now)!.totalQuantity,1);
 c.clear();assert.equal(c.search({q:'更新後'},fields,now),null);
 let allowed=false,status=401,reads=0;
 const sources={
  'next/server':'export class NextResponse { static json(body,init={}) {return new Response(JSON.stringify(body),init);} }',
  '@/lib/mobile/session':'export const getMobileSession=()=>ports.session();',
  '@/lib/inventory/queries':'export const listCategories=async()=>[];export const listLocations=listCategories;export const listStatuses=listCategories;',
  '@/lib/mobile/searchCatalog':'export const readSearchCatalog=()=>ports.read();export const cachedSearchCatalog=async()=>({items:await ports.read(),checkedAt:new Date().toISOString()});',
 };
 const bundle=await build({entryPoints:['app/api/mobile/search-catalog/route.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in sources?{path:a.path,namespace:'qa'}:undefined);b.onLoad({filter:/.*/,namespace:'qa'},a=>({contents:sources[a.path as keyof typeof sources]}));}}]});
 const module={exports:{} as {GET():Promise<Response>}};
 vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,Response,require:createRequire(import.meta.url),ports:{session:()=>allowed?{ok:true,owner:'staff-1'}:{ok:false,status,error:'DENIED'},read:()=>{reads++;return[];}}});
 for(status of [401,403,503])assert.equal((await module.exports.GET()).status,status);
 assert.equal(reads,0);allowed=true;const res=await module.exports.GET();assert.equal(res.status,200);assert.match(res.headers.get('cache-control')!,/no-store/);assert.equal((await res.json()).owner,'staff-1');
 console.log('PASS: 6000-item matching, pagination, count, expiry, detail fallback, edit/delete races, logout clear and authenticated no-store route.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

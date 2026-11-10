// Real route validation and filter forwarding with isolated transport; never AWS writes.
const assert=require('node:assert/strict'),{build}=require('esbuild'),vm=require('node:vm');
async function main(){
 let allowed=true,reads=0,last;
 const ports={session:()=>allowed?{ok:true,owner:'test',role:'EDITOR',features:{sales:false,ecListing:false}}:{ok:false,status:403,error:'FORBIDDEN'},
  search:async filters=>{reads++;last=filters;return {items:[],offset:0,total:0,totalQuantity:0,hasNext:false};}};
 const masters=`export const listFastCategories=async()=>[{id:'a',name:'販売中'},{id:'b',name:'市川確認'}];export const listFastLocations=async()=>[];export const listFastStatuses=async()=>[];export const listFastCustomFieldDefinitions=async()=>[];`;
 const mocks={
  'next/server':`export const NextResponse={json:(data,init={})=>new Response(JSON.stringify(data),init)};`,
  '@/lib/mobile/session':`export const getMobileSession=()=>globalThis.ports.session();`,
  '@/lib/mobile/editMasters':masters,
  '@/lib/inventory/queries':`export const listInventoryMobileSearch=(filters)=>globalThis.ports.search(filters);export const listInventory=listInventoryMobileSearch;`,
  '@/lib/inventory/inventoryPage':`export const listInventoryOffsetPage=async()=>({usedIndex:false});`,
  '@/lib/inventory/listImageUrls':`export const withListImageUrls=async rows=>rows;`,
  '@/lib/inventory/thumbnailRecords':`export const readThumbnailRecords=async()=>[];`,
  '@/lib/mobile/inventoryThumbnails':`export const inventoryThumbnails=async()=>[];`,
 };
 const result=await build({entryPoints:['app/api/mobile/inventory/route.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'isolated',setup(b){
  b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'test'}:undefined);
  b.onLoad({filter:/.*/,namespace:'test'},a=>({contents:mocks[a.path],loader:'js'}));
 }}]});
 const module={exports:{}};vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,ports,URL,Response,Date,Map,Set,console});
 const get=params=>module.exports.GET(new Request('https://test.invalid/api/mobile/inventory?'+new URLSearchParams({...params,images:'deferred'})));
 allowed=false;assert.equal((await get({categoryIds:'["a"]'})).status,403);assert.equal(reads,0);allowed=true;
 for(const categoryIds of ['oops','{}','[1]','["unknown"]',JSON.stringify(Array(101).fill('a'))])assert.equal((await get({categoryIds})).status,400);
 assert.equal(reads,0);
 assert.equal((await get({categoryIds:'["a","b","a"]'})).status,200);assert.equal(JSON.stringify(last.categoryIds),'["a","b"]');
 assert.equal((await get({category:'市川確認'})).status,200);assert.equal(JSON.stringify(last.categoryIds),'["b"]');
 for(const operator of ['anyOf','allOf','noneOf']){
  const advanced={combinator:'AND',conditions:[{id:'1',field:'categoryId',operator,values:['a','b']}]};
  assert.equal((await get({advanced:JSON.stringify(advanced)})).status,200);assert.equal(JSON.stringify(last.advanced),JSON.stringify(advanced));
 }
 assert.equal((await get({advanced:JSON.stringify({combinator:'AND',conditions:[{id:'1',field:'salePrice',operator:'eq',value:'1'}]})})).status,400);
 console.log('PASS mobile route: auth denial, invalid/unknown/oversized IDs, dedupe, legacy category, any/all/none, restricted field');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

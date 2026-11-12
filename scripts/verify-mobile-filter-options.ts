import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
async function main(){
 let authorized=true,categoryFails=false,otherFails=true;
 const calls:string[]=[];
 const ports={session:async()=>authorized?{ok:true,owner:'staff',features:{sales:true,ecListing:true}}:{ok:false,status:401,error:'UNAUTHORIZED'},
  categories:async()=>{calls.push('categories');if(categoryFails)throw Error('private failure');return [{id:'repair-id',name:'補修待ち'},{id:'photo-id',name:'撮影待ち'}];},
  other:async(name:string)=>{calls.push(name);if(otherFails)throw Error('other master unavailable');return [];}};
 const sources:Record<string,string>={
  '@/lib/mobile/session':'export const getMobileSession=()=>globalThis.ports.session();',
  '@/lib/mobile/editMasters':'export const listFastCategories=()=>globalThis.ports.categories();export const listFastLocations=()=>globalThis.ports.other("locations");export const listFastStatuses=()=>globalThis.ports.other("statuses");export const listFastCustomFieldDefinitions=()=>globalThis.ports.other("customFields");',
  'next/server':'export class NextResponse {static json(body,init={}){return Response.json(body,init);}}',
 };
 const bundle=await build({entryPoints:['app/api/mobile/options/route.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>sources[a.path]?{path:a.path,namespace:'stub'}:undefined);b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:sources[a.path],loader:'js'}));}}]});
 const module={exports:{} as {GET(request:Request):Promise<Response>}};
 vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,ports,Response,URL});
 const get=(scope=true)=>module.exports.GET(new Request('https://bello.invalid/api/mobile/options'+(scope?'?scope=categories':'')));
 let r=await get();assert.equal(r.status,200);assert.deepEqual(calls,['categories']);
 assert.deepEqual(await r.json(),{owner:'staff',choices:[{value:'repair-id',label:'補修待ち'},{value:'photo-id',label:'撮影待ち'}]});
 assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('vary'),'Cookie');
 calls.length=0;authorized=false;r=await get();assert.equal(r.status,401);assert.deepEqual(calls,[]);
 authorized=true;categoryFails=true;r=await get();assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'UNAVAILABLE'});
 categoryFails=false;r=await get();assert.equal(r.status,200,'retry recovers');
 r=await get(false);assert.equal(r.status,503,'full options still report unrelated master failure');
 otherFails=false;r=await get(false);assert.equal(r.status,200);assert.equal((await r.json()).categories.length,2);
 console.log('PASS: category-only reads, unrelated-master failure isolation, authentication, no-store, failure status, recovery, existing full-options response');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

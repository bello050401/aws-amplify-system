const assert=require('node:assert/strict'),esbuild=require('esbuild'),vm=require('node:vm');
(async()=>{
 const sandbox={module:{exports:{}},exports:{},console:{warn(){}},fixture:{archive:null,item:null,error:false,calls:0}};
 const built=await esbuild.build({entryPoints:['lib/inquiry/baseProductLookup.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'fake-boundaries',setup(b){
 b.onResolve({filter:/^server-only$|^@\/lib\/amplify\/dataClient$|^@\/lib\/base$|^@\/lib\/amplify\/listAll$/},a=>({path:a.path,namespace:'fake'}));
 b.onLoad({filter:/.*/,namespace:'fake'},a=>({contents:a.path==='@/lib/base'?'export const getBaseClient=()=>({getItem:async()=>{globalThis.fixture.calls++;if(globalThis.fixture.error)throw Error("unavailable");return globalThis.fixture.item;}});':a.path.endsWith('dataClient')?'export const inventoryAuthMode={};export const serverDataClient={models:{BaseProductArchive:{get:async()=>({data:globalThis.fixture.archive})}}};':a.path.endsWith('listAll')?'export const unwrapGet=x=>x.data;':'',loader:'js'}));
 }}]});vm.runInNewContext(built.outputFiles[0].text,sandbox);const lookup=sandbox.module.exports.lookupBaseProduct,f=sandbox.fixture;let passed=0;
 f.archive={baseItemId:'157908850',title:'old title',price:74800,stock:1,visible:true};f.item={itemId:'157908850',title:'current title',price:61800,stock:1,images:[],isPublished:true};
 let r=await lookup('157908850');assert.equal(r.source,'api');assert.equal(r.price,61800);assert.equal(f.calls,1);passed++;
 f.error=true;r=await lookup('157908850');assert.equal(r.source,'archive');assert.equal(r.price,null);assert.equal(r.stock,null);assert.equal(r.isPublished,null);passed++;
 f.error=false;f.item=null;r=await lookup('157908850');assert.equal(r.price,null);assert.equal(r.source,'archive');passed++;
 f.archive=null;r=await lookup('157908850');assert.equal(r.source,'not-found');passed++;
 const before=f.calls;r=await lookup('https://another-host/anything');assert.equal(r.source,'not-found');assert.equal(f.calls,before);passed++;
 console.log(JSON.stringify({passed,externalCalls:0,externalWrites:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});

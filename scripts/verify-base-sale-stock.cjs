const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 const b=await build({entryPoints:['lib/listing/base/adapter.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});
 const writes=[];let enabled='1';class ApiError extends Error{constructor(code,message){super(message);this.code=code;}}
 const mods={'server-only':{},'@/lib/base/oauth':{getAccessToken:async()=> 'fixture-token'},'./errors':{BaseListingApiError:ApiError},'@/lib/integrations/writeGuard':{assertExternalWriteAllowed:()=>{throw Error('no broad writes');}},'../descriptionFormat':{},'../commonSettings':{},'./visibility':{},'./privateTestGuard':{},'@/lib/http/fetchWithTimeout':{fetchWithTimeout:async(u,r)=>{writes.push({url:u,params:Object.fromEntries(r.body)});return new Response(JSON.stringify({item:{item_id:'123'}}),{status:200});}}};
 const module={exports:{}},env={get BASE_MANUAL_LISTING_ENABLED(){return enabled;}};
 vm.runInNewContext(b.outputFiles[0].text,{module,exports:module.exports,require:k=>{if(!(k in mods))throw Error(k);return mods[k];},process:{env},URLSearchParams,Response});
 const set=module.exports.setManualBaseStock;
 await set('123',2,'【在庫2】チェア');assert.deepEqual(JSON.parse(JSON.stringify(writes)),[{url:'https://api.thebase.in/1/items/edit',params:{item_id:'123',stock:'2',title:'【在庫2】チェア'}}]);
 await set('123',0);assert.equal(writes[1].params.stock,'0');assert.equal(Object.keys(writes[1].params).sort().join(','),'item_id,stock');
 for(const args of [['123',-1],['123',1.5],['123',100001],['123',2,''],['123',2,'x'.repeat(1001)],['bad',2]])await assert.rejects(()=>set(...args));
 assert.equal(writes.length,2);enabled='0';await assert.rejects(()=>set('123',2,'椅子'));assert.equal(writes.length,2);
 console.log('PASS BASE sale adapter: exact stock+title request, zero stock, bounds, no price/visibility fields, disabled writes rejected');
})().catch(e=>{console.error(e);process.exitCode=1;});

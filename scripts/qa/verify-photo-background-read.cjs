const assert=require('node:assert/strict'),vm=require('node:vm'),{build}=require('esbuild');
async function load(file,ports,globals={}) {
 const out=await build({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in ports?{path:a.path,external:true}:undefined)}}]});
 const m={exports:{}};vm.runInNewContext(out.outputFiles[0].text,{module:m,exports:m.exports,require:k=>{assert(k in ports,k);return ports[k]},URL,URLSearchParams,AbortController,setTimeout,clearTimeout,console,...globals});return m.exports;
}
(async()=>{
 let verified=false,reads=0,badges=0,permissionError=false,unavailable=false;
 const route=await load('app/api/inventory/photo-previews/route.ts',{
  'next/server':{NextResponse:{json:(body,options)=>({body,...options})}},
  '@/lib/inventory/mutationSession':{inventoryVerifiedReadSession:async()=>verified?{role:'EDITOR',owner:'test'}:null},
  '@/app/actions/photoRegistration':{
   getPhotoRegistrationBadgeAction:async()=>{badges++;return{count:2,hasMore:false}},
   listInventoryPrimaryPhotoThumbnailsAction:async ids=>{reads++;if(unavailable)throw Error('private backend details');if(permissionError)return{ok:false,code:'PERMISSION_DENIED',message:'private'};assert.deepEqual(Array.from(ids),['a','b']);return{ok:true,value:{a:{url:'photo-a',explicitPrimary:true},b:null}}},
  },
 });
 const get=q=>route.GET({url:'https://test.invalid/api/inventory/photo-previews?'+q});
 assert.equal((await get('ids=a,b')).status,401);assert.equal(reads,0);assert.equal(badges,0);
 verified=true;
 for(const q of ['','ids=','ids=../secret','ids='+Array(101).fill('a').join(','),'badge=1&ids=a','badge=no'])assert.equal((await get(q)).status,400);
 assert.equal(reads,0);assert.equal(badges,0);
 const photos=await get('ids=a,a,b');assert.equal(photos.body.value.a.url,'photo-a');assert.equal(photos.body.value.a.explicitPrimary,true);assert.equal(photos.body.value.b,null);assert.match(photos.headers['Cache-Control'],/no-store/);assert.equal(photos.headers.Vary,'Cookie');
 const badge=await get('badge=1');assert.equal(badge.body.value.count,2);assert.equal(badges,1);
 permissionError=true;assert.equal((await get('ids=a,b')).status,403);permissionError=false;unavailable=true;const failed=await get('ids=a,b');assert.equal(failed.status,503);assert(!JSON.stringify(failed.body).includes('private'));

 let effect,updates=[],requests=[];
 const hook=await load('app/inventory/usePrimaryPhotoThumbnails.ts',{
  react:{useEffect:fn=>{effect=fn},useState:()=>[null,update=>updates.push(update)]},
 },{fetch:async(url,options)=>{let resolve;const promise=new Promise(r=>resolve=r);requests.push({url,options,resolve});return promise;}});
 hook.usePrimaryPhotoThumbnails(['old']);let cleanup=effect();assert.equal(requests.length,1);assert.equal(requests[0].options.credentials,'same-origin');assert.equal(requests[0].options.cache,'no-store');
 cleanup();assert(requests[0].options.signal.aborted);
 requests[0].resolve({ok:true,json:async()=>({ok:true,value:{old:{url:'stale',explicitPrimary:true}}})});await new Promise(r=>setImmediate(r));assert.equal(updates.length,0,'late prior-page photos must be ignored');
 hook.usePrimaryPhotoThumbnails(['new']);cleanup=effect();requests[1].resolve({ok:true,json:async()=>({ok:true,value:{new:{url:'fresh',explicitPrimary:false}}})});await new Promise(r=>setImmediate(r));assert.equal(updates.length,1);assert.equal(updates[0].key,'new');assert.equal(updates[0].photos.new.url,'fresh');cleanup();
 hook.usePrimaryPhotoThumbnails(['broken']);cleanup=effect();requests[2].resolve({ok:false});await new Promise(r=>setImmediate(r));assert.equal(updates.length,1,'failed reads must not erase fallback photos');cleanup();
 hook.usePrimaryPhotoThumbnails([],true);cleanup=effect();assert.equal(requests.length,3);cleanup();
 hook.usePrimaryPhotoThumbnails(['disabled'],false);cleanup=effect();assert.equal(requests.length,3);cleanup();
 console.log('PASS photo background reads: verified auth before reads; bounded IDs; existing permissions and primary-photo selection; no-store; safe errors; independent HTTP; abort on page change; stale response ignored; fallback preserved; empty/disabled no request');
})().catch(e=>{console.error(e);process.exitCode=1});

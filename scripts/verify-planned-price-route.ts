import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
async function main(){
 let role='EDITOR',allowed=true,reads=0,writes=0;
 const sources:Record<string,string>={
 'next/server':'export class NextResponse { static json(body, init={}) { return new Response(JSON.stringify(body), init); } }',
 'next/cache':'export const revalidatePath=()=>{};',
 '@/lib/mobile/session':'export const getMobileSession=()=>ports.session();',
 '@/lib/inventory/plannedPriceService':'export const listPriceEntry=()=>ports.read();export const updatePriceEntry=(body,actor)=>ports.write(body,actor);',
 };
 const compiled=await build({entryPoints:['app/api/inventory/planned-price/route.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in sources?{path:a.path,namespace:'qa'}:undefined);b.onLoad({filter:/.*/,namespace:'qa'},a=>({contents:sources[a.path]}));}}]});
 const module={exports:{} as {GET():Promise<Response>;POST(r:Request):Promise<Response>}};
 vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,Response,URL,Buffer,process:{env:{}},ports:{session:async()=>allowed?{ok:true,role,owner:'staff'}:{ok:false,status:401,error:'AUTH'},read:async()=>{reads++;return [];},write:async()=>{writes++;return{id:'test'};}}});
 const post=(origin='https://bello.example',body='{}')=>module.exports.POST(new Request('https://bello.example/api/inventory/planned-price',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body}));
 allowed=false;assert.equal((await module.exports.GET()).status,401);assert.equal((await post()).status,401);
 allowed=true;role='VIEWER';assert.equal((await module.exports.GET()).status,403);assert.equal((await post()).status,403);assert.equal(reads+writes,0);
 role='EDITOR';assert.equal((await post('https://wrong.example')).status,403);assert.equal(writes,0);
 assert.equal((await post('https://bello.example','{"x":"'+'a'.repeat(132000)+'"}')).status,503);assert.equal(writes,0);
 for(const r of ['EDITOR','ADMIN']){role=r;const read=await module.exports.GET();assert.equal(read.status,200);assert.match(read.headers.get('cache-control')!,/no-store/);assert.equal((await post()).status,200);}
 assert.equal(writes,2);console.log('PASS: actual route rejects anonymous, viewer, cross-origin and oversized requests; editor/admin allowed; no-store enabled.');
}main().catch(e=>{console.error(e);process.exitCode=1;});

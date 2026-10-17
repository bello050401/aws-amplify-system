import assert from "node:assert/strict";
import {build} from "esbuild";
import vm from "node:vm";
import {createRequire} from "node:module";
import sharp from "sharp";
async function main(){
  let session:any={ok:true,owner:"11111111-1111-4111-8111-111111111111",role:"EDITOR",features:{sales:true}};
  let uploads:any[]=[];let summaries=0,details=0;
  const ports={session:async()=>session,feature:async()=>session.ok&&!session.features.sales?{ok:false,status:403,error:"FEATURE_FORBIDDEN"}:session,
    upload:(value:any)=>{uploads.push(value);return {result:Promise.resolve({})};},summary:async(y:number,m:number)=>{summaries++;return {year:y,month:m,status:"ok",aggregateRebuiltAt:"2025-01-31T00:00:00Z",totals:{totalSales:1000},trend:[]};},items:async()=>{details++;return [{id:"synthetic"}];}};
  const sources:Record<string,string>={
    'next/server':'export class NextResponse {static json(body,init={}){return new Response(JSON.stringify(body),{...init,headers:{"Content-Type":"application/json",...init.headers}})}}',
    'next/headers':'export const cookies=()=>({});',
    '@/lib/mobile/session':'export const getMobileSession=()=>globalThis.ports.session();export const requireMobileFeature=()=>globalThis.ports.feature();',
    '@/lib/amplify/serverUtils':'export const runWithAmplifyServerContext=({operation})=>operation({});',
    'aws-amplify/storage/server':'export const uploadData=(_,value)=>globalThis.ports.upload(value);',
    '@/lib/inventory/salesView':'export const loadSalesSummary=(...args)=>globalThis.ports.summary(...args);export const loadSalesItems=(...args)=>globalThis.ports.items(...args);',
  };
  async function route(path:string){const bundle=await build({entryPoints:[path],bundle:true,write:false,platform:"node",format:"cjs",external:["sharp"],plugins:[{name:"test",setup(b){b.onResolve({filter:/.*/},a=>sources[a.path]?{path:a.path,namespace:"stub"}:undefined);b.onLoad({filter:/.*/,namespace:"stub"},a=>({contents:sources[a.path],loader:"js"}));}}]});const module={exports:{}as any};vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,ports,Request,Response,URL,Date,Buffer,process:{env:{BELLO_MOBILE_WRITES_ENABLED:"true"}},require:createRequire(import.meta.url)});return module.exports;}
  const media=await route('app/api/mobile/images/route.ts');const bytes=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).jpeg().toBuffer();
  const post=(body:BodyInit,extra:Record<string,string>={})=>media.POST(new Request('https://bello.example/api/mobile/images',{method:'POST',headers:{'Content-Type':'image/jpeg','X-Bello-Mobile':'1','X-Photo-Id':'11111111-1111-4111-8111-111111111111',...extra},body}));
  session.role='VIEWER';assert.equal((await post(bytes)).status,403);assert.equal(uploads.length,0);session.role='EDITOR';
  assert.equal((await post(bytes,{Origin:'https://other.example'})).status,403);assert.equal((await post(bytes,{'X-Photo-Id':'../x'})).status,422);
  assert.equal((await post(Buffer.alloc(3*1024*1024+1))).status,413);assert.equal(uploads.length,0);
  assert.equal((await post(Buffer.from('not an image'))).status,503);assert.equal(uploads.length,0);
  const first=await post(bytes);assert.equal(first.status,200);const saved=await first.json();assert.match(saved.storageKey,/^inventory\/mobile\/11111111-/);
  assert.equal((await (await post(bytes)).json()).storageKey,saved.storageKey);assert.equal(uploads[0].options.contentType,'image/jpeg');assert.equal((await sharp(uploads[0].data).metadata()).format,'jpeg');
  const sales=await route('app/api/mobile/sales/route.ts');const get=(q='')=>sales.GET(new Request('https://bello.example/api/mobile/sales?y=2025&m=1'+q));
  session.features.sales=false;assert.equal((await get()).status,403);assert.equal(summaries,0);session.features.sales=true;
  const summary=await get();assert.equal(summary.status,200);assert.equal((await summary.json()).view.totals.totalSales,1000);assert.equal(summaries,1);assert.equal(details,0);
  assert.equal((await get('&items=1')).status,200);assert.equal(details,1);assert.equal(summaries,1);
  assert.equal((await sales.GET(new Request('https://bello.example/api/mobile/sales?y=99999&m=99'))).status,422);
  console.log('PASS: photo permission/origin/size/bytes/normalization/identity; sales denial, shared summary and on-demand detail paths. Synthetic storage only.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

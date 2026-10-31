import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {build} from 'esbuild';
import {buildCatalogDelta} from '../lib/mobile/catalogDelta';
import {applyCatalogDelta,CATALOG_RETENTION_MS,CATALOG_MAX_BYTES,compactCatalogItem} from '../mobile/src/domain/catalogProtocol';
import {CatalogStore} from '../mobile/src/domain/catalogStore';
import {QuickSearchCatalog} from '../mobile/src/domain/quickSearch';
import {cachedInventorySearch,cachedSearchFields} from '../mobile/src/domain/search';
import {RESTRICTED_FEATURES} from '../mobile/src/domain/access';
import {reusableThumbnail} from '../mobile/src/domain/thumbnailFreshness';
import type {InventoryItem} from '../mobile/src/domain/inventory';
import {mkdirSync,writeFileSync} from 'node:fs';
const checks:string[]=[];
async function main(){
 const now=Date.now(),date=new Date(now).toISOString();
 const rows:InventoryItem[]=Array.from({length:6000},(_,n)=>({id:`test-${n}`,sku:`B${n}`,displayId:String(n),name:`${n%2?'Ｃａｓｓｉｎａ チェア':'カリモク テーブル'} ${n}`,quantity:n%7,unit:'点',location:'所沢事務所',category:n%2?'補修待ち,椅子':'撮影待ち',condition:'',note:'private note',barcode:'2026'+n,plannedSalePrice:n%3?null:15000,thumbnailUrl:'https://example.invalid/private-image',createdAt:`2026-01-${String(n%28+1).padStart(2,'0')}`,updatedAt:`2026-10-${String(n%28+1).padStart(2,'0')}`}));
 const first=buildCatalogDelta(rows,undefined,date),state=applyCatalogDelta(null,first),q=new QuickSearchCatalog();
 assert.equal(first.buckets.length,64);assert(q.accept(first,q.version()));
 const fields=cachedSearchFields(rows,RESTRICTED_FEATURES),times:number[]=[];
 const originalVersion=q.version(),originalManifest=q.manifest();
 assert.equal(q.observe({...rows[1],detailLoadedAt:date,photosComplete:true}),false);
 assert.equal(q.version(),originalVersion);assert.deepEqual(q.manifest(),originalManifest);assert(!q.needsSync());
 const observed=new QuickSearchCatalog();observed.accept(first,observed.version());
 assert(observed.observe({...rows[1],quantity:2,name:'最新詳細',updatedAt:date}));
 assert(observed.needsSync());assert.equal(observed.search({q:'最新詳細'},fields)!.totalQuantity,2);
 assert(!observed.accept(first,0));
 checks.push('変更なし詳細は差分同期/検索再構築を省略・変更ありは最新数量と名称に更新・古い応答は拒否');
 for(const name of ['', 'チェア','cassina','テーブル','不存在'])for(const field of ['updatedAt','createdAt','quantity','name','plannedSalePrice','sku','displayId','unit'])for(const direction of ['asc','desc'] as const){
  const input={q:name,sort:{field,direction}},started=performance.now(),actual=q.search(input,fields)!;
  times.push(performance.now()-started);
  const expected=cachedInventorySearch(rows,input,fields);
  assert.deepEqual(actual.items.map(i=>i.id),expected.slice(0,50).map(i=>i.id));assert.equal(actual.total,expected.length);assert.equal(actual.totalQuantity,expected.reduce((s,i)=>s+i.quantity,0));
 }
 const barcode={advanced:{combinator:'AND' as const,conditions:[{id:'code',field:'barcode',operator:'equals' as const,value:rows[5500].barcode}]}};
 assert.deepEqual(q.search(barcode,fields)!.items.map(i=>i.id),[rows[5500].id]);
 checks.push('6000件・80通りの検索/並び順/件数/数量、バーコード一致');
 const same=buildCatalogDelta([...rows].reverse(),state.hashes,date);assert.equal(same.buckets.length,0);
 const updated=rows.slice(1).map(i=>i.id===rows[1].id?{...i,name:'更新済み',quantity:2,updatedAt:date}:i);
 updated.push({...rows[0],id:'inserted',name:'新規商品'});
 const delta=buildCatalogDelta(updated,state.hashes,date),next=applyCatalogDelta(state,delta);
 assert(delta.buckets.length<=3);assert(!next.items.some(i=>i.id===rows[0].id));assert.equal(next.items.find(i=>i.id===rows[1].id)!.quantity,2);
 const empty=applyCatalogDelta(state,buildCatalogDelta([],state.hashes,date));assert.equal(empty.items.length,0);
 assert.throws(()=>applyCatalogDelta(state,{...delta,buckets:[]}));assert.throws(()=>applyCatalogDelta(state,{...delta,total:4000}));
 assert.throws(()=>applyCatalogDelta(null,{...first,buckets:[...first.buckets,first.buckets[0]]}));
 assert.equal(state.items.length,6000);
 checks.push('変更なし0グループ・追加/編集/物理削除・全削除・壊れた差分の全拒否');
 const revision=q.version();q.update([{...rows[1],name:'手元で更新',quantity:1}], [rows[0].id]);
 assert.equal(q.accept(first,revision),false);assert(q.needsSync());
 assert.equal(q.search({q:'手元で更新'},fields)!.totalQuantity,1);
 q.accept(buildCatalogDelta(updated,q.manifest(),date),q.version());
 assert(!q.reconcile(rows.slice(0,4)).some(i=>i.id===rows[0].id));assert.equal(q.reconcile(rows.slice(0,4))[0].name,'更新済み');
 checks.push('更新中の旧応答で巻き戻らない・削除と編集を既存500件キャッシュへ反映');
 const data=new Map<string,string>();
 const storage={getItem:async(k:string)=>data.get(k)??null,setItem:async(k:string,v:string)=>{data.set(k,v);},removeItem:async(k:string)=>{data.delete(k);}};
 const store=new CatalogStore(storage,'one','https://bello.test');await store.write(state);
 const raw=[...data.values()][0];assert(!raw.includes('private note'));assert(!raw.includes('private-image'));assert(Buffer.byteLength(raw)<CATALOG_MAX_BYTES);
 const twoDays={...state,checkedAt:new Date(now-2*86400000).toISOString()};await store.write(twoDays);
 const restart=new QuickSearchCatalog();assert(restart.restore((await new CatalogStore(storage,'one','https://bello.test').read())!,0));assert(restart.ready());assert(restart.needsSync());assert.equal(restart.search({q:'チェア'},fields)!.total,3000);
 assert.equal(await new CatalogStore(storage,'two','https://bello.test').read(),null);
 await store.write({...state,checkedAt:new Date(now-CATALOG_RETENTION_MS-1).toISOString()});assert.equal(await store.read(),null);
 data.set([...data.keys()][0]??'bad','broken');
 await store.write(state);const key=[...data.keys()].find(k=>k.startsWith('bello.search'))!;data.set(key,'broken');assert.equal(await store.read(),null);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
 const slow=new CatalogStore({...storage,setItem:async(k,v)=>{started();await gate;data.set(k,v);}},'slow','https://bello.test');
 const saving=slow.write(state);await began;const clearing=slow.clearOnLogout();release();await Promise.all([saving,clearing]);await slow.write(state);
 assert(![...data.keys()].some(k=>k.endsWith('.slow')));
 const full=new CatalogStore({...storage,setItem:async()=>{throw Error('quota');}},'full','https://bello.test');await assert.rejects(full.write(state));assert.equal(q.search({q:'更新済み'},fields)!.total,1);
 checks.push('2日後の復元・30日期限・所有者隔離・破損/容量不足・ログアウト競合・個人情報/写真非保存');
 assert(reusableThumbnail('https://example.test/photo?X-Amz-Date=20261029T000000Z&X-Amz-Expires=900',Date.parse('2026-10-29T00:05:00Z')));
 assert(!reusableThumbnail('https://example.test/photo?X-Amz-Date=20261029T000000Z&X-Amz-Expires=900',Date.parse('2026-10-30T00:05:00Z')));
 checks.push('期限切れの写真URLを再利用しない');
 let allowed=false,status=401,reads=0,fail=false;
 const sources:Record<string,string>={
  'next/server':'export class NextResponse {static json(b,i={}){return new Response(JSON.stringify(b),i)}}',
  '@/lib/mobile/session':'export const getMobileSession=()=>ports.session();',
  '@/lib/inventory/queries':'export const listCategories=async()=>[];export const listLocations=listCategories;export const listStatuses=listCategories;',
  '@/lib/mobile/searchCatalog':'export const readSearchCatalog=()=>ports.read();export const cachedSearchCatalog=async()=>({items:await ports.read(),checkedAt:new Date().toISOString()});',
 };
 const bundle=await build({entryPoints:['app/api/mobile/search-catalog/route.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in sources?{path:a.path,namespace:'qa'}:undefined);b.onLoad({filter:/.*/,namespace:'qa'},a=>({contents:sources[a.path]}));}}]});
 const module={exports:{} as {POST(r:Request):Promise<Response>}};
 vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,Response,Buffer,require:createRequire(import.meta.url),ports:{session:()=>allowed?{ok:true,owner:'one'}:{ok:false,status,error:'DENIED'},read:()=>{reads++;if(fail)throw Error('outage');return rows;}}});
 const req=(body:unknown)=>new Request('https://bello.test/api/mobile/search-catalog',{method:'POST',body:JSON.stringify(body)});
 for(status of [401,403,503])assert.equal((await module.exports.POST(req({}))).status,status);assert.equal(reads,0);
 allowed=true;for(const invalid of [null,{hashes:['bad']},{fresh:'yes'},{hashes:Array(64).fill('X'.repeat(1000))}])assert.equal((await module.exports.POST(req(invalid))).status,400);assert.equal(reads,0);
 const response=await module.exports.POST(req({}));assert.equal(response.status,200);assert.match(response.headers.get('cache-control')!,/no-store/);const body=await response.json();assert.equal(body.owner,'one');assert.equal(body.total,6000);
 const unchanged=await(await module.exports.POST(req({hashes:body.hashes}))).json();assert.equal(unchanged.buckets.length,0);
 fail=true;assert.equal((await module.exports.POST(req({}))).status,503);
 checks.push('API認証401/403/503時の未読・入力検証・アカウント照合用owner・no-store・障害503');
 const report={passed:checks,rows:rows.length,serializedBytes:Buffer.byteLength(raw),initialBytes:Buffer.byteLength(JSON.stringify(first)),noChangeBytes:Buffer.byteLength(JSON.stringify(same)),threeChangeBytes:Buffer.byteLength(JSON.stringify(delta)),queryMsMax:Math.max(...times),queryMsMedian:times.sort((a,b)=>a-b)[Math.floor(times.length/2)]};
 mkdirSync('artifacts/persistent-web-search-20261029',{recursive:true});writeFileSync('artifacts/persistent-web-search-20261029/unit-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

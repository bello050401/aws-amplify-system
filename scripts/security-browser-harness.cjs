/** Loopback-only Next.js integration fixture. No AWS/data/real identities. */
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/security-20261026/browser-harness');
const put=(name,value)=>{const p=path.join(out,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,value);};
put('package.json',JSON.stringify({name:'bello-security-browser-fixture',private:true}));
put('next.config.js',`module.exports={serverExternalPackages:[],experimental:{serverActions:{bodySizeLimit:'2mb'}}};`);
if(fs.existsSync(path.join(out,'runtime.ts')))fs.unlinkSync(path.join(out,'runtime.ts'));
put('runtime.js',`
import fs from 'node:fs';
import {SecurityService} from '${path.join(root,'lib/security/service').replaceAll('\\','/')}';
import {SecurityError} from '${path.join(root,'lib/security/types').replaceAll('\\','/')}';
const filename=${JSON.stringify(path.join(out,'state.json'))};
function read(){try{return JSON.parse(fs.readFileSync(filename,'utf8'));}catch{return{};}}
export const store={async get(id){return read()[id];},async write(ops){const rows=read();for(const op of ops){if((rows[op.row?.id??op.deleteId]?.version??null)!==op.expected)throw new SecurityError('STALE_RECORD',409);}for(const op of ops)op.row?rows[op.row.id]=op.row:delete rows[op.deleteId];fs.writeFileSync(filename,JSON.stringify(rows));},async rate(){},async list(kind){return{items:Object.values(read()).filter(x=>x.kind===kind)};}};
const provider={async start(){return{identity:{sub:'fixture-staff',username:'fixture-staff',groups:['EDITOR'],tokens:{access:'fixture-access-token-never-to-browser',id:'fixture-id-token-never-to-browser',refresh:'fixture-refresh-never-to-browser',expiresAt:Math.floor(Date.now()/1000)+300}}};},async hasPasskey(){return true;},async refresh(){throw Error('not used');},async revoke(){}};
export const service=new SecurityService(store,{async seal(v){return JSON.stringify(v)},async open(v){return JSON.parse(v)}},provider,'http://localhost:4318');
export const contextKey='fixture-context-key-never-to-browser-1234567890';
export const deviceSecurityEnabled=()=>true;
export const securityRuntime=async()=>({service,contextKey});
`);
put('middleware.js',`import {NextResponse} from 'next/server';import {approvedDeviceBoundary} from './boundary';export const middleware=request=>request.nextUrl.pathname==='/api/fixture'?NextResponse.next():approvedDeviceBoundary(request);export const config={matcher:['/((?!_next/static|_next/image|security-worker.js).*)'],runtime:'nodejs'};`);
put('app/layout.js',`export default function Layout({children}){return <html lang="ja"><body>{children}</body></html>}`);
put('app/page.js',`export default function Page(){return <iframe src="/fixture.html" title="ブラウザー境界検証" style={{width:'100%',height:'90vh',border:0}}/>}`);
put('app/security/route.js',`export async function GET(){return new Response('端末の承認・ログインが必要です。',{headers:{'content-type':'text/plain;charset=utf-8','cache-control':'no-store'}});}`);
put('app/api/fixture/route.js',`
import {service,store} from '../../../runtime';
import {COOKIE} from '${path.join(root,'lib/security/http').replaceAll('\\','/')}';
import {hash} from '${path.join(root,'lib/security/crypto').replaceAll('\\','/')}';
export async function POST(request){if(request.headers.get('origin')!=='http://localhost:4318')return new Response('denied',{status:403});
const input=await request.json();const ctx={origin:'http://localhost:4318',ip:'127.0.0.1',userAgent:'isolated-browser-fixture'};
if(input.operation==='revoke'){const all=await store.list('device');for(const d of all.items)await store.write([{expected:d.version,row:{...d,version:d.version+1,status:'revoked',generation:d.generation+1}}]);return Response.json({revoked:true});}
const result=await service.begin({username:'fixture-staff',mode:'passkey',key:input.key,name:'Browser fixture',shared:false},ctx);
const session=await store.get('session#'+hash(result.sessionToken)),device=await store.get(session.deviceId);
await store.write([{expected:device.version,row:{...device,version:device.version+1,status:'approved'}}]);
return Response.json({binding:hash(session.id)},{headers:{'set-cookie':COOKIE+'='+result.sessionToken+';Path=/;Secure;HttpOnly;SameSite=Strict;Max-Age=900','cache-control':'no-store'}});}
`);
put('app/api/business/inventory/route.js',`
import {headers,cookies} from 'next/headers';import {readServerGrant,GRANT_HEADER} from '${path.join(root,'lib/security/serverGrant').replaceAll('\\','/')}';import {contextKey} from '../../../../runtime';
export async function GET(){const h=await headers(),jar=await cookies();const grant=readServerGrant(h.get(GRANT_HEADER),jar.get('__Host-bello-session')?.value??'',contextKey);return Response.json({ok:true,quantity:5,role:grant.groups[0],source:'actual Next middleware'},{headers:{'cache-control':'no-store'}});}
export async function POST(request){await GET();const body=await request.json();return Response.json({ok:true,received:body.quantity},{headers:{'cache-control':'no-store'}});}
`);
put('app/inventory/Counter.js',`'use client';import {useState} from 'react';export default function Counter(){const [n,set]=useState(0);return <button onClick={()=>set(n+1)}>画面操作確認 {n}</button>}`);
put('app/inventory/page.js',`import {GET} from '../api/business/inventory/route';import Counter from './Counter';export default async function Page(){const result=await(await GET()).json();return <main><h1>業務ページの表示確認</h1><p>承認済み端末：在庫数量 {result.quantity}</p><p>認証トークンは画面へ出力していません。</p><Counter/><div id="injection-result">未承認スクリプトは未実行</div><script dangerouslySetInnerHTML={{__html:"document.querySelector('#injection-result').textContent='INJECTION EXECUTED'"}}/></main>}`);
put('public/fixture.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><title>ブラウザー境界検証</title><h1>BELLO ブラウザー境界検証</h1><p>ローカル検証専用。本人認証は検証用の代替処理です。本番データには接続しません。</p><button id="prepare">検証用ログインを準備</button><button id="read">在庫APIを確認</button><button id="write">署名付き保存を確認</button><button id="revoke">端末承認を解除</button><a href="/inventory" target="_top">業務ページに移動</a><pre id="result" role="status"></pre><script src="/fixture.js"></script></html>`);
put('public/fixture.js',`
const result=document.querySelector('#result');const json=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return await r.json()};
const save=async(k,v)=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('bello-approved-browser-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('settings');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});await new Promise((res,rej)=>{const t=db.transaction('settings','readwrite');t.objectStore('settings').put(v,k);t.oncomplete=res;t.onerror=rej});db.close()};
document.querySelector('#prepare').onclick=async()=>{try{const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);const r=await json('/api/fixture',{key:await crypto.subtle.exportKey('jwk',key.publicKey)});await save('keyPair',key);await save('requestBinding',r.binding);await navigator.serviceWorker.register('/security-worker.js',{scope:'/'});await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(res=>navigator.serviceWorker.addEventListener('controllerchange',res,{once:true}));result.textContent='準備完了：秘密鍵の取り出し不可 / トークンはHttpOnly';}catch(e){result.textContent=e.message}};
document.querySelector('#read').onclick=async()=>{const r=await fetch('/api/business/inventory');result.textContent=r.status+' '+await r.text()};
document.querySelector('#write').onclick=async()=>{const r=await json('/api/business/inventory',{quantity:2});result.textContent=JSON.stringify(r)};
document.querySelector('#revoke').onclick=async()=>{await json('/api/fixture',{operation:'revoke'});result.textContent='端末承認を解除しました。次の在庫API操作は拒否されます。'};
`);
put('server.cjs',`const next=require('next'),http=require('node:http');const app=next({dev:process.env.FIXTURE_DEV==='1',dir:__dirname,hostname:'localhost',port:4318});app.prepare().then(()=>http.createServer(app.getRequestHandler()).listen(4318,'127.0.0.1',()=>console.log('Loopback security fixture ready')));`);
(async()=>{
await esbuild.build({entryPoints:[path.join(root,'lib/security/nextBoundary.ts')],outfile:path.join(out,'boundary.js'),bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'fixture-runtime',setup(build){build.onResolve({filter:/serverRuntime$/},()=>({path:path.join(out,'runtime.js')}));}}]});
fs.copyFileSync(path.join(root,'public/security-worker.js'),path.join(out,'public/security-worker.js'));
console.log(out);
})();

/** Real local Next.js middleware/RSC HTTP boundary; no AWS or production data. */
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,createHash,sign} from 'node:crypto';
import {requestProofMessage} from '../lib/security/requestProof';
const origin='http://localhost:4318',hash=(s:string)=>createHash('sha256').update(s).digest('base64url');
let passed=0;
const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
async function main(){
const setup=await fetch(origin+'/api/fixture',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({key:key.publicKey.export({format:'jwk'})})});
assert.equal(setup.status,200);const cookie=setup.headers.getSetCookie()[0].split(';')[0],state=await setup.json() as {binding:string};
async function request(target:string,method='GET',body='',changes:Record<string,string>={}){
 const p={version:1 as const,at:Math.floor(Date.now()/1000),nonce:randomBytes(32).toString('base64url'),binding:state.binding,digest:hash(body)};
 const signature=sign('sha256',Buffer.from(requestProofMessage(origin,method,target,p)),{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return fetch(origin+target,{method,redirect:'manual',headers:{origin,cookie,'content-type':'application/json','x-bello-device-proof':JSON.stringify({...p,signature}),...changes},...(body?{body}:{})});
}
async function check(name:string,fn:()=>Promise<void>){await fn();passed++;console.log('PASS '+name);}
await check('Cookie without proof denied',async()=>{const r=await fetch(origin+'/api/business/inventory',{headers:{cookie}});assert.equal(r.status,401);});
await check('Caller-supplied internal grant cannot bypass middleware',async()=>{const r=await fetch(origin+'/api/business/inventory',{headers:{cookie,'x-bello-server-grant':'forged'}});assert.equal(r.status,401);});
await check('Valid proof works and no internal JWT/grant reaches HTTP response',async()=>{const r=await request('/api/business/inventory');assert.equal(r.status,200);const text=JSON.stringify([...r.headers])+await r.text();assert(!/fixture-access-token|fixture-id-token|fixture-refresh|x-bello-server-grant|x-middleware-request/.test(text));assert(r.headers.get('cache-control')?.includes('no-store'));});
await check('POST body survives middleware verification',async()=>{const r=await request('/api/business/inventory','POST','{"quantity":2}');assert.equal(r.status,200);assert.equal((await r.json() as {received:number}).received,2);});
await check('RSC/HTML server rendering works without serializing JWTs',async()=>{const r=await request('/inventory','GET','',{accept:'text/html'});assert.equal(r.status,200);const text=await r.text();assert(text.includes('在庫数量'));assert(!/fixture-access-token|fixture-id-token|fixture-refresh|x-bello-server-grant/.test(text));});
await check('CSP has per-request nonce; Next scripts carry that nonce',async()=>{const r=await request('/inventory','GET','',{accept:'text/html'});const csp=r.headers.get('content-security-policy')??'',nonce=csp.match(/'nonce-([^']+)'/)?.[1];assert(nonce);assert(csp.includes("'strict-dynamic'"));assert(!csp.includes("'unsafe-eval'"));assert((await r.text()).includes('nonce="'+nonce+'"'));const second=await request('/inventory','GET','',{accept:'text/html'});assert.notEqual(second.headers.get('content-security-policy'),csp);});
await fetch(origin+'/api/fixture',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"operation":"revoke"}'});
await check('Revocation rejects old key and session on actual HTTP route',async()=>{assert.equal((await request('/api/business/inventory')).status,403);});
await check('Revoked browser navigation returns to login instead of raw JSON',async()=>{const r=await request('/inventory','GET','',{accept:'text/html'});assert.equal(r.status,307);assert(r.headers.get('location')?.includes('/security?returnTo='));assert.equal(r.headers.get('referrer-policy'),'no-referrer');});
console.log(JSON.stringify({passed,failed:0,realNextHttp:true,provider:'isolated-memory-fixture',biometrics:false}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});

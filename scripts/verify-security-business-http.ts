/** Real full BELLO routes, isolated AWS schema, loopback bootstrap only.
 * No external commerce, mail, ZAICO or production data is invoked. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {generateKeyPairSync,randomBytes,randomUUID,createHash,sign} from 'node:crypto';
import sharp from 'sharp';
import {DynamoSecurityStore} from '../lib/security/awsStore';
import {KmsVault} from '../lib/security/awsVault';
import type {Session,Tokens} from '../lib/security/types';
import {requestProofMessage} from '../lib/security/requestProof';
import {execFileSync} from 'node:child_process';
import {S3Client,GetObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
const origin='http://localhost:4319',hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('base64url');
const outputs=JSON.parse(fs.readFileSync('amplify_outputs.json','utf8')),pilot=JSON.parse(fs.readFileSync('cdk.out/security/pilot-outputs.json','utf8')).BelloSecurityPilot20261026;
if(outputs.storage.bucket_name!=='amplify-bellosecuritybusi-belloinventorystoragebuc-alf7jbmof57c'||pilot.PoolId!=='us-west-2_JUoq4susA')throw Error('Isolated resources only');
const results:{name:string;result:string;ms:number}[]=[];
async function setup(role:string,pending=false){
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const r=await fetch(origin+'/security-stage-fixture',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({role,pending,key:keys.publicKey.export({format:'jwk'})})});assert.equal(r.status,200);
 const cookie=r.headers.getSetCookie()[0].split(';')[0],{binding}=await r.json() as {binding:string};
 return{cookie,keys,binding};
}
async function request(b:Awaited<ReturnType<typeof setup>>,target:string,method='GET',body:string|Buffer='',extra:Record<string,string>={}){
 const p={version:1 as const,at:Math.floor(Date.now()/1000),nonce:randomBytes(32).toString('base64url'),binding:b.binding,digest:hash(body)};
 const signature=sign('sha256',Buffer.from(requestProofMessage(origin,method,target,p)),{key:b.keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return fetch(origin+target,{method,redirect:'manual',headers:{origin,cookie:b.cookie,'content-type':'application/json','x-bello-mobile':'1','x-bello-device-proof':JSON.stringify({...p,signature}),...extra},...(body.length?{body:body as BodyInit}:{})});
}
async function test(name:string,fn:()=>Promise<void>){const start=Date.now();await fn();results.push({name,result:'PASS',ms:Date.now()-start});console.log('PASS '+name)}
async function main(){
 const admin=await setup('ADMIN'),editor=await setup('EDITOR'),viewer=await setup('VIEWER'),cms=await setup('Admins'),pending=await setup('EDITOR',true);
 const target='/api/mobile/inventory?images=deferred';
 await test('ADMIN reads the actual full-schema inventory API',async()=>{const r=await request(admin,target);assert.equal(r.status,200);const data=await r.json() as any;assert.equal(data.role,'ADMIN');assert(data.items.some((x:any)=>x.name.startsWith('SECURITY_QA_20261026')));});
 await test('EDITOR and VIEWER retain inventory read access',async()=>{for(const b of [editor,viewer])assert.equal((await request(b,target)).status,200)});
 await test('Pending device cannot access full business API',async()=>assert.equal((await request(pending,target)).status,403));
 await test('CMS-only Admins cannot read inventory',async()=>assert.equal((await request(cms,target)).status,403));
 await test('Unsigned old-style cookie cannot access actual API',async()=>assert.equal((await fetch(origin+target,{headers:{cookie:admin.cookie}})).status,401));
 await test('VIEWER cannot create stock; no mutation is attempted',async()=>assert.equal((await request(viewer,'/api/mobile/inventory/'+randomUUID(),'POST','{}')).status,403));
 await test('Invoice product search accepts the approved confidential-client ADMIN session',async()=>{const r=await request(admin,'/api/invoicing/products?q=');assert.equal(r.status,200);assert.deepEqual(await r.json(),{items:[]});assert(r.headers.get('cache-control')?.includes('no-store'))});
 await test('Invoice status reaches only the isolated unconfigured issuer; staff are denied',async()=>{const r=await request(admin,'/api/invoicing/status','POST','{}',{'x-bello-invoicing':'1'});assert.equal(r.status,409);assert.equal((await r.json() as any).code,'NOT_CONFIGURED');for(const b of [editor,viewer,cms])assert.equal((await request(b,'/api/invoicing/products?q=')).status,403)});
 const key='inventory/'+randomUUID()+'.png',url='/api/inventory/storage?path='+encodeURIComponent(key),bytes=await sharp({create:{width:320,height:320,channels:3,background:'#2a6ca0'}}).png().toBuffer();
 try{
 await test('Approved EDITOR uploads image through signed application boundary',async()=>assert.equal((await request(editor,url,'PUT',bytes,{'content-type':'image/png'})).status,200));
 await test('Image download is byte-identical and has no-store',async()=>{const r=await request(viewer,url);assert.equal(r.status,200);assert(r.headers.get('cache-control')?.includes('no-store'));assert(Buffer.from(await r.arrayBuffer()).equals(bytes))});
 await test('VIEWER and CMS cannot upload images',async()=>{for(const b of [viewer,cms])assert.equal((await request(b,url,'PUT',bytes,{'content-type':'image/png'})).status,403)});
 await test('S3 object is inaccessible without approved application access',async()=>assert.equal((await fetch('https://'+outputs.storage.bucket_name+'.s3.us-west-2.amazonaws.com/'+key)).status,403));
 await test('Identity Pool temporary credentials cannot bypass S3 device gate',async()=>{
  const aws=(op:string,args:string[])=>JSON.parse(execFileSync('C:/Program Files/Amazon/AWSCLIV2/aws.exe',['cognito-identity',op,...args,'--no-sign-request','--region','us-west-2','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const id=aws('get-id',['--identity-pool-id',outputs.auth.identity_pool_id]);
  const c=aws('get-credentials-for-identity',['--identity-id',id.IdentityId]).Credentials;
  const s3=new S3Client({region:'us-west-2',credentials:{accessKeyId:c.AccessKeyId!,secretAccessKey:c.SecretKey!,sessionToken:c.SessionToken}});
  await assert.rejects(()=>s3.send(new GetObjectCommand({Bucket:outputs.storage.bucket_name,Key:key})),(e:any)=>e.$metadata?.httpStatusCode===403);
 });
 await test('Valid Cognito token cannot bypass AppSync through direct call',async()=>{
  const state=await new DynamoSecurityStore(pilot.Table,'us-west-2').get<Session>('session#'+hash(admin.cookie.slice(admin.cookie.indexOf('=')+1)));
  const tokens=await new KmsVault(pilot.KeyArn,'us-west-2','bello-security-pilot-20261026').open<Tokens>(state!.vault);
  const r=await fetch(outputs.data.url,{method:'POST',headers:{authorization:tokens.id,'content-type':'application/json'},body:JSON.stringify({query:'query { listInventories(limit: 1) { items { id } } }'})});
  assert.equal(r.status,403);
 });
 await test('Public API key cannot read private inventory',async()=>{const r=await fetch(outputs.data.url,{method:'POST',headers:{'x-api-key':outputs.data.api_key,'content-type':'application/json'},body:JSON.stringify({query:'query { listInventories(limit: 1) { items { id } } }'})});assert.equal(r.status,403)});
 await fetch(origin+'/security-stage-fixture',{method:'POST',headers:{origin,cookie:editor.cookie,'content-type':'application/json'},body:'{"operation":"revoke"}'});
 await test('Revocation blocks real API and image with existing session/key',async()=>{assert.equal((await request(editor,target)).status,403);assert.equal((await request(editor,url)).status,403)});
 await test('Cross-site OAuth landing cannot execute protected callback',async()=>{const r=await fetch(origin+'/api/base/oauth/callback?state=qa&code=qa',{headers:{'sec-fetch-site':'cross-site','sec-fetch-dest':'document'},redirect:'manual'});assert.equal(r.status,200);const body=await r.text();assert(body.includes('location.replace(location.href)'));assert(!body.includes('code=qa'));assert(r.headers.get('cache-control')?.includes('no-store'))});
 }finally{await new S3Client({region:'us-west-2'}).send(new DeleteObjectCommand({Bucket:outputs.storage.bucket_name,Key:key}));}
 fs.writeFileSync('artifacts/security-20261026/business-http-results.json',JSON.stringify({results,productionChanged:false,hardwareBiometrics:'NOT_TESTED',bootstrap:'loopback test identity; real Cognito tokens and business schema'},null,2));
 console.log(JSON.stringify({passed:results.length,failed:0}));
}
main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1});

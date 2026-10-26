/** Real HTTPS + Cognito WebAuthn protocol, isolated resources only.
 * Software authenticator: never count this as Face ID / Windows Hello hardware QA.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,createHash,sign} from 'node:crypto';
import {CognitoIdentityProviderClient,AdminCreateUserCommand,AdminSetUserPasswordCommand,AdminAddUserToGroupCommand,AdminDisableUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import {DynamoSecurityStore} from '../lib/security/awsStore';
import type {Device,User} from '../lib/security/types';
import {requestProofMessage} from '../lib/security/requestProof';
import {keyId} from '../lib/security/crypto';
import {isIP} from 'node:net';
const outputs=JSON.parse(fs.readFileSync('artifacts/security-20261026/hosted-outputs/amplify_outputs.json','utf8'));
const config=outputs.custom.deviceSecurity,origin='https://codex-security-20261026.d4hkkg7dty2du.amplifyapp.com',host=new URL(origin).hostname;
assert.equal(config.origin,origin);assert.equal(config.poolId,'us-west-2_iCUa4QWvi');assert.equal(config.phase,'enforced');
const store=new DynamoSecurityStore(config.table,'us-west-2'),cognito=new CognitoIdentityProviderClient({region:'us-west-2'});
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest();
function cbor(v:any):Buffer{
 const h=(m:number,n:number):Buffer=>n<24?Buffer.from([m*32+n]):n<256?Buffer.from([m*32+24,n]):n<65536?Buffer.from([m*32+25,n>>8,n&255]):Buffer.from([m*32+26,n>>>24,(n>>>16)&255,(n>>>8)&255,n&255]);
 if(Buffer.isBuffer(v))return Buffer.concat([h(2,v.length),v]);
 if(typeof v==='string'){const b=Buffer.from(v);return Buffer.concat([h(3,b.length),b])}
 if(typeof v==='number')return v>=0?h(0,v):h(1,-v-1);
 if(v instanceof Map)return Buffer.concat([h(5,v.size),...[...v].flatMap(([k,x])=>[cbor(k),cbor(x)])]);
 throw Error('Invalid test CBOR');
}
function browser(role:string){return{role,key:generateKeyPairSync('ec',{namedCurve:'prime256v1'}),passkey:generateKeyPairSync('ec',{namedCurve:'prime256v1'}),cookie:'',username:'qa-hosted-'+role.toLowerCase()+'-'+Date.now()+'@bello.invalid',password:'Qa1!'+randomBytes(24).toString('base64url'),sub:'',userId:'',credentialId:randomBytes(32),counter:0}}
type Browser=ReturnType<typeof browser>;
async function post(b:Browser,path:string,body:unknown,expected=200){
 const r=await fetch(origin+path,{method:'POST',redirect:'error',headers:{origin,'content-type':'application/json',...(b.cookie?{cookie:b.cookie}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 const raw=await r.text();let data:any;try{data=JSON.parse(raw)}catch{throw Error('Non-JSON HTTP '+r.status+' at '+path)}
 assert.equal(r.status,expected,'HTTP at '+path+' error='+data.error);
 const cookie=r.headers.getSetCookie()[0];if(cookie){assert(cookie.includes('HttpOnly'));assert(cookie.includes('Secure'));assert(cookie.includes('SameSite=Strict'));b.cookie=cookie.split(';')[0]}
 assert(!/"(AccessToken|RefreshToken|IdToken)"/.test(raw));return data;
}
async function action(b:Browser,input:unknown,expected=200){
 const payload=JSON.stringify(input),c=await post(b,'/api/security/challenge',{digest:hash(payload).toString('base64url')});
 const signature=sign('sha256',Buffer.from(c.message),{key:b.key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return post(b,'/api/security/action',{payload,proof:{challengeId:c.challengeId,signature}},expected);
}
async function business(b:Browser,path:string,expected:number,binding?:string,extra:Record<string,string>={}){
 const p={version:1 as const,at:Math.floor(Date.now()/1000),nonce:randomBytes(32).toString('base64url'),binding:binding??(await action(b,{action:'status'})).requestBinding,digest:hash('').toString('base64url')};
 const signature=sign('sha256',Buffer.from(requestProofMessage(origin,'GET',path,p)),{key:b.key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 const r=await fetch(origin+path,{redirect:'manual',headers:{origin,cookie:b.cookie,'x-bello-device-proof':JSON.stringify({...p,signature}),...extra},signal:AbortSignal.timeout(60000)});
 assert.equal(r.status,expected,'Business '+path);return r;
}
async function create(b:Browser){
 const r=await cognito.send(new AdminCreateUserCommand({UserPoolId:config.poolId,Username:b.username,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:b.username},{Name:'email_verified',Value:'true'}]}));
 b.sub=r.User!.Attributes!.find(a=>a.Name==='sub')!.Value!;
 await cognito.send(new AdminSetUserPasswordCommand({UserPoolId:config.poolId,Username:b.username,Password:b.password,Permanent:true}));
 await cognito.send(new AdminAddUserToGroupCommand({UserPoolId:config.poolId,Username:b.username,GroupName:b.role}));
}
async function password(b:Browser){await post(b,'/api/security/login',{username:b.username,password:b.password,mode:'password',name:'HTTPS protocol QA',key:b.key.publicKey.export({format:'jwk'}),shared:false})}
async function enroll(b:Browser){
 const r=await action(b,{action:'enrollStart'}),o=typeof r.options==='string'?JSON.parse(r.options):r.options;
 assert.equal(o.rp.id,host);assert.equal(o.authenticatorSelection.userVerification,'required');b.userId=o.user.id;
 const pub=b.passkey.publicKey.export({format:'jwk'}),cose=cbor(new Map<any,any>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(pub.x!,'base64url')],[-3,Buffer.from(pub.y!,'base64url')]]));
 const authData=Buffer.concat([hash(host),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,b.credentialId.length]),b.credentialId,cose]);
 const clientDataJSON=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:o.challenge,origin,crossOrigin:false})).toString('base64url');
 await action(b,{action:'enrollFinish',credential:{id:b.credentialId.toString('base64url'),rawId:b.credentialId.toString('base64url'),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON,attestationObject:cbor(new Map<any,any>([['fmt','none'],['attStmt',new Map()],['authData',authData]])).toString('base64url'),transports:['internal']}}});
}
async function passkey(b:Browser){
 const r=await post(b,'/api/security/login',{username:b.username,mode:'passkey',key:b.key.publicKey.export({format:'jwk'}),name:'HTTPS protocol QA',shared:false});
 assert.equal(r.step,'WEB_AUTHN');const o=r.options;assert.equal(o.rpId,host);
 const clientData=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:o.challenge,origin,crossOrigin:false})),counter=Buffer.alloc(4);counter.writeUInt32BE(++b.counter);
 const authData=Buffer.concat([hash(host),Buffer.from([0x05]),counter]);
 await post(b,'/api/security/finish',{flowToken:r.flowToken,answer:{id:b.credentialId.toString('base64url'),rawId:b.credentialId.toString('base64url'),type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:clientData.toString('base64url'),authenticatorData:authData.toString('base64url'),signature:sign('sha256',Buffer.concat([authData,hash(clientData)]),b.passkey.privateKey).toString('base64url'),userHandle:b.userId}}});
}
const results:{name:string,result:string,ms:number}[]=[];
async function test(name:string,fn:()=>Promise<void>){const t=Date.now();try{await fn();results.push({name,result:'PASS',ms:Date.now()-t});console.log('PASS '+name)}catch(e){results.push({name,result:'FAIL',ms:Date.now()-t});throw e}}
async function main(){
 const admin=browser('ADMIN'),staff=browser('EDITOR'),created:Browser[]=[];
 const probeAgent='BELLO-edge-proof-'+randomBytes(12).toString('hex'),spoofId='CLIENT_SUPPLIED_FAKE_ID_0123456789';
 let probeRequestId='';
 try{
 await test('Public HTTPS authentication screen and no loopback bypass',async()=>{
  const r=await fetch(origin+'/security');assert.equal(r.status,200);assert((await r.text()).includes('パスキー'));assert(r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  assert.equal((await fetch(origin+'/security-stage-fixture',{method:'POST'})).status,404);
  assert.equal((await fetch(origin+'/api/mobile/inventory')).status,401);
  const redirect=await fetch(origin+'/inventory',{redirect:'manual',headers:{accept:'text/html','x-forwarded-host':'attacker.invalid'}});
  assert.equal(redirect.status,307);assert.equal(new URL(redirect.headers.get('location')!).origin,origin);
 });
 await test('Cross-site requests remain denied and cannot choose a trusted origin',async()=>{
  for(const headers of [new Headers({origin:'https://attacker.invalid'}),new Headers({origin,'sec-fetch-site':'cross-site'})]){
   const r=await fetch(origin+'/api/mobile/inventory',{headers});assert.equal(r.status,403);assert.equal((await r.json() as any).error,'INVALID_ORIGIN');
  }
 });
 for(const path of ['/api/base/oauth/callback','/api/invoicing/oauth/callback','/api/sale-candidates/oauth']){
  await test('HTTPS OAuth return is inert until signed same-origin navigation: '+path,async()=>{
   const url=origin+path+'?code=qa_invalid&state=qa_invalid';
   const r=await fetch(url,{redirect:'manual',headers:{'sec-fetch-site':'cross-site','sec-fetch-dest':'document'}});
   assert.equal(r.status,200);assert(r.headers.get('cache-control')?.includes('no-store'));assert.equal(r.headers.get('referrer-policy'),'no-referrer');
   const body=await r.text();assert(body.includes('location.replace(location.href)'));assert(!body.includes('qa_invalid'));assert(!r.headers.has('set-cookie'));
   const retry=await fetch(url,{redirect:'manual',headers:{'sec-fetch-site':'same-origin','sec-fetch-dest':'document'}});
   assert.equal(retry.status,307);const next=new URL(retry.headers.get('location')!);assert.equal(next.origin,origin);assert.equal(next.pathname,'/security');
  });
 }
 await test('CloudFront replaces a client-supplied request ID before the audit boundary',async()=>{
  const r=await fetch(origin+'/api/security/login',{method:'POST',headers:{origin,'content-type':'application/json','user-agent':probeAgent,'x-amz-cf-id':spoofId,'x-forwarded-for':'198.51.100.77','cloudfront-viewer-address':'198.51.100.77:443'},body:'{}'});
  assert.equal(r.status,400);await r.text();
  let probe:any;
  for(let i=0;i<5;i++){probe=(await store.list('event')).items.find(x=>x.userAgent===probeAgent);if(probe)break;await new Promise(r=>setTimeout(r,1000));}
  assert(probe);assert.equal(probe.ip,'hosting-unverified');assert(probe.edgeRequestId);assert.notEqual(probe.edgeRequestId,spoofId);
  probeRequestId=String(probe.edgeRequestId);
 });
 for(const b of [admin,staff]){await create(b);created.push(b)}
 await test('HTTPS password bootstrap issues secure opaque cookie only',()=>password(admin));
 await test('Real Cognito registration and login with software passkey',async()=>{await enroll(admin);await passkey(admin)});
 await test('Even ADMIN is denied business data until device approval',()=>business(admin,'/api/mobile/inventory',403).then(()=>{}));
 // Explicit isolated test bootstrap, not a production recovery test or HTTP bypass.
 const id='device#'+admin.sub+'#'+keyId(admin.key.publicKey.export({format:'jwk'}) as JsonWebKey),d=await store.get<Device>(id);assert(d);assert.equal(d.status,'pending');
 await store.write([{expected:d.version,row:{...d,version:d.version+1,status:'approved'}}]);
 await test('Approved ADMIN can read actual isolated inventory',async()=>{const r=await business(admin,'/api/mobile/inventory?images=deferred',200);assert.equal((await r.json() as any).role,'ADMIN')});
 await test('Signed BASE invalid-state callback cannot redirect through a forged host',async()=>{
  const r=await business(admin,'/api/base/oauth/callback?state=qa_invalid&code=qa_invalid',307,undefined,{'x-forwarded-host':'attacker.invalid','x-forwarded-proto':'http'});
  const next=new URL(r.headers.get('location')!);assert.equal(next.origin,origin);assert.equal(next.pathname,'/inventory/settings');assert(next.searchParams.has('baseError'));assert(!next.searchParams.has('baseConnected'));
 });
 await test('Approved session cookie alone cannot read business data',async()=>{
  const r=await fetch(origin+'/api/mobile/inventory',{headers:{origin,cookie:admin.cookie}});assert.equal(r.status,401);assert.equal((await r.json() as any).error,'DEVICE_PROOF_REQUIRED');
 });
 await test('ADMIN audit resolves the actual AWS IP while ignoring forged IP headers',async()=>{
  let record:any;
  for(let i=0;i<18;i++){
   record=(await action(admin,{action:'events'})).items.find((x:any)=>x.edgeRequestId===probeRequestId);
   if(record?.edgeIpVerified)break;
   await new Promise(r=>setTimeout(r,5000));
  }
  assert.equal(record?.edgeIpVerified,true,'Verified WAF evidence must be available');assert(isIP(record.ip));assert.notEqual(record.ip,'198.51.100.77');
  assert(!('httpRequest' in record));assert(!('headers' in record));
  let device:any;
  for(let i=0;i<18;i++){
   device=(await action(admin,{action:'devices'})).items.find((x:any)=>x.sub===admin.sub);
   if(device?.edgeIpVerified)break;
   await new Promise(r=>setTimeout(r,5000));
  }
  assert.equal(device?.edgeIpVerified,true);assert.equal(device.lastIp,record.ip);
  assert(!device.publicKey);assert(!device.verificationCode);
 });
 await test('EDITOR authenticates but remains pending on another browser key',async()=>{await password(staff);await enroll(staff);await passkey(staff);await business(staff,'/api/mobile/inventory',403)});
 let target:any;
 await test('ADMIN approves staff with matching verification code',async()=>{
  const s=await action(staff,{action:'status'});target=(await action(admin,{action:'devices'})).items.find((x:any)=>x.sub===staff.sub&&x.status==='pending');assert(target);assert(!target.verificationCode);
  await action(admin,{action:'approve',deviceId:target.id,expectedVersion:target.version,verificationCode:s.verificationCode,personConfirmed:true});
 });
 await test('Approved EDITOR reads existing inventory but cannot issue invoices',async()=>{await business(staff,'/api/mobile/inventory?images=deferred',200);await business(staff,'/api/invoicing/products?q=',403)});
 const binding=(await action(staff,{action:'status'})).requestBinding;
 await test('ADMIN revocation immediately blocks the existing staff session on actual API',async()=>{
  target=(await action(admin,{action:'devices'})).items.find((x:any)=>x.id===target.id);await action(admin,{action:'revoke',deviceId:target.id,expectedVersion:target.version});
  await business(staff,'/api/mobile/inventory',403,binding);
 });
 await test('Direct public API key cannot read business data',async()=>{assert.equal((await fetch(outputs.data.url,{method:'POST',headers:{'content-type':'application/json','x-api-key':outputs.data.api_key},body:JSON.stringify({query:'query { listInventories(limit:1){items{id}} }'})})).status,403)});
 }finally{
  for(const b of created){await cognito.send(new AdminDisableUserCommand({UserPoolId:config.poolId,Username:b.username}));const u=await store.get<User>('user#'+b.sub);if(u)await store.write([{expected:u.version,row:{...u,version:u.version+1,enabled:false,generation:u.generation+1}}])}
  fs.writeFileSync('artifacts/security-20261026/hosted-results.json',JSON.stringify({origin,results,productionChanged:false,hardwareBiometrics:'NOT_TESTED',testAccountsDisabled:true},null,2));
 }
 console.log(JSON.stringify({passed:results.filter(r=>r.result==='PASS').length,failed:results.filter(r=>r.result==='FAIL').length}));
}
main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1});

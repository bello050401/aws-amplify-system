import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { SecurityService } from "../lib/security/service";
import { hash } from "../lib/security/crypto";
import { securityHttp, COOKIE } from "../lib/security/http";
import { hasBusinessPermission } from "../lib/security/accessPolicy";
import { assertCutoverReady, cutoverReadiness } from "../lib/security/rolloutPolicy";
import { SecurityError, type Store, type Row, type Mutation, type Provider, type Identity, type Tokens, type Context, type Device, type User, type Vault } from "../lib/security/types";

let time = 1800000000;
class MemoryStore implements Store {
  rows = new Map<string,Row>(); counters=new Map<string,number>();
  async get<T extends Row>(id:string){const x=this.rows.get(id);return x?structuredClone(x) as T:undefined;}
  async write(ops:Mutation[]){
    for(const op of ops){const id="row" in op?op.row.id:op.deleteId,actual=this.rows.get(id)?.version??null;
      if(actual!==op.expected)throw new SecurityError("STALE_RECORD",409);}
    for(const op of ops){"row" in op?this.rows.set(op.row.id,structuredClone(op.row)):this.rows.delete(op.deleteId);}
  }
  async list(kind:string){return{items:[...this.rows.values()].filter(x=>x.kind===kind).map(x=>structuredClone(x))};}
  async rate(key:string,limit:number,window:number,now:number){const k=key+Math.floor(now/window),n=(this.counters.get(k)??0)+1;this.counters.set(k,n);if(n>limit)throw new SecurityError("TOO_MANY_REQUESTS",429);}
}
const store=new MemoryStore();
const fixtureVault:Vault={seal:async v=>JSON.stringify(v),open:async v=>JSON.parse(v)};
const profiles:Record<string,{groups:string[],passkey:boolean}>={admin:{groups:["ADMIN"],passkey:true},staff:{groups:["EDITOR"],passkey:true},fresh:{groups:["EDITOR"],passkey:false},viewer:{groups:["VIEWER"],passkey:true},cms:{groups:["Admins"],passkey:true},outsider:{groups:[],passkey:true}};
function identity(name:string):Identity{return{sub:name,username:name,groups:profiles[name].groups,tokens:{access:name,id:"id-"+name,refresh:"refresh-"+name,expiresAt:time+300}};}
let refreshCount=0,refreshFailure=false;
const provider:Provider={
  start:async(name,mode)=>{if(!profiles[name]||mode==="passkey"&&!profiles[name].passkey)throw Error();return{identity:identity(name)};},
  finish:async()=>{throw Error("not used");},hasPasskey:async t=>profiles[t.access].passkey,
  enrollStart:async()=>({challenge:"test-only"}),enrollFinish:async t=>{profiles[t.access].passkey=true;},
  refresh:async t=>{refreshCount++;if(refreshFailure)throw new SecurityError("UPSTREAM_UNAVAILABLE",503);return identity(t.access);},revoke:async()=>{},
};
const origin="https://security.example.test",ctx:Context={origin,ip:"192.0.2.10",userAgent:"test"};
const service=new SecurityService(store,fixtureVault,provider,origin,()=>time);
type Browser=ReturnType<typeof browser>;
function browser(){const keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"});return{keys,publicKey:keys.publicKey.export({format:"jwk"}),token:""};}
async function login(b:Browser,user:string,mode:"passkey"|"password"="passkey",shared=false){const r=await service.begin({username:user,mode,key:b.publicKey,name:user+" PC",shared},ctx);assert(r.sessionToken);b.token=r.sessionToken;}
async function proof(b:Browser,body:unknown,context=ctx){
 const payload=JSON.stringify(body),c=await service.challenge(b.token,hash(payload),context);
 return{payload,proof:{challengeId:c.challengeId,signature:sign("sha256",Buffer.from(c.message),{key:b.keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")}};
}
async function call(b:Browser,body:unknown,context=ctx){const p=await proof(b,body,context);return await service.perform(b.token,p.payload,p.proof,context) as any;}
async function rejects(fn:()=>Promise<unknown>,code:string){await assert.rejects(fn,(e:unknown)=>e instanceof SecurityError&&e.code===code);}
async function device(b:Browser){const s=await store.get<Row>("session#"+hash(b.token));return(await store.get<Device>(String(s!.deviceId)))!;}
async function trustedBootstrap(b:Browser){const d=await device(b);await store.write([{row:{...d,version:d.version+1,status:"approved"},expected:d.version}]);}
let passed=0;
async function test(name:string,fn:()=>Promise<void>){await fn();passed++;console.log("PASS "+name);}
const admin=browser(),staff=browser(),fresh=browser();
async function main() {
await login(admin,"admin");await trustedBootstrap(admin);await login(staff,"staff");

await test("Pending device: authenticated staff cannot read business data",async()=>{await rejects(()=>call(staff,{action:"businessProbe"}),"DEVICE_PENDING");});
await test("Pending is not rejection",async()=>{assert.equal((await call(staff,{action:"status"})).status,"pending");});
await test("Cookies alone cannot authorize: wrong private key denied",async()=>{const b=browser();b.token=staff.token;await rejects(()=>call(b,{action:"businessProbe"}),"INVALID_DEVICE_PROOF");});
await test("Origin spoofing/CSRF rejected",async()=>{await rejects(()=>proof(staff,{action:"status"},{...ctx,origin:"https://evil.test"}),"INVALID_ORIGIN");});
await test("Changed operation after signing rejected",async()=>{const p=await proof(staff,{action:"status"});await rejects(()=>service.perform(staff.token,JSON.stringify({action:"businessProbe"}),p.proof,ctx),"INVALID_DEVICE_PROOF");});
await test("One proof cannot be replayed",async()=>{const p=await proof(staff,{action:"status"});await service.perform(staff.token,p.payload,p.proof,ctx);await rejects(()=>service.perform(staff.token,p.payload,p.proof,ctx),"INVALID_DEVICE_PROOF");});
await test("Expired challenge denied even when TTL record still exists",async()=>{const p=await proof(staff,{action:"status"});time+=61;await rejects(()=>service.perform(staff.token,p.payload,p.proof,ctx),"INVALID_DEVICE_PROOF");});
await test("Approval requires contact verification and matching code",async()=>{const d=await device(staff);await rejects(()=>call(admin,{action:"approve",deviceId:d.id,expectedVersion:d.version,personConfirmed:true,verificationCode:"wrong"}),"PERSON_VERIFICATION_REQUIRED");});
await test("Staff cannot approve a device",async()=>{await rejects(()=>call(staff,{action:"devices"}),"DEVICE_PENDING");});
await test("Approval makes existing pending session usable",async()=>{const d=await device(staff);await call(admin,{action:"approve",deviceId:d.id,expectedVersion:d.version,personConfirmed:true,verificationCode:d.verificationCode});assert.equal((await call(staff,{action:"businessProbe"})).ok,true);});
await test("Approved staff still cannot use admin API",async()=>{await rejects(()=>call(staff,{action:"devices"}),"ADMIN_REQUIRED");});
await test("Changing IP does not require reapproval",async()=>{assert.equal((await call(staff,{action:"businessProbe"},{...ctx,ip:"198.51.100.33"})).ok,true);});
await test("Another browser using same account/passkey needs separate approval",async()=>{const other=browser();await login(other,"staff");await rejects(()=>call(other,{action:"businessProbe"}),"DEVICE_PENDING");});
await test("Browser reopen with same key and cookie stays logged in",async()=>{const reopened={...staff};assert.equal((await call(reopened,{action:"status"})).approved,true);});
await test("Password-only sign-in never becomes authorized on approved device",async()=>{const b={...staff};await login(b,"staff","password");await rejects(()=>call(b,{action:"businessProbe"}),"PASSKEY_REQUIRED");await rejects(()=>call(b,{action:"enrollStart"}),"PASSKEY_REQUIRED");});
await test("First enrollment works but requires passkey login afterwards",async()=>{await login(fresh,"fresh","password");await call(fresh,{action:"enrollStart"});await call(fresh,{action:"enrollFinish",credential:{fixture:true}});assert.equal((await call(fresh,{action:"status"})).needsPasskeyLogin,true);});
await test("Explicit rejection is distinct and blocks enrollment",async()=>{const d=await device(fresh);await call(admin,{action:"reject",deviceId:d.id,expectedVersion:d.version});assert.equal((await call(fresh,{action:"status"})).status,"rejected");await rejects(()=>call(fresh,{action:"enrollStart"}),"DEVICE_REJECTED");});
await test("Revocation rejects an already issued session on next request",async()=>{const d=await device(staff);await call(admin,{action:"revoke",deviceId:d.id,expectedVersion:d.version});await rejects(()=>call(staff,{action:"businessProbe"}),"DEVICE_REVOKED");});
await test("Revoked key cannot silently enroll again",async()=>{await login(staff,"staff");assert.equal((await call(staff,{action:"status"})).status,"revoked");await rejects(()=>call(staff,{action:"businessProbe"}),"DEVICE_REVOKED");});
await test("Unknown Cognito roles never grant access",async()=>{await rejects(()=>login(browser(),"outsider"),"NO_STAFF_ROLE");});
await test("Administrator cannot revoke their current control device",async()=>{const d=await device(admin);await rejects(()=>call(admin,{action:"revoke",deviceId:d.id,expectedVersion:d.version}),"CANNOT_REVOKE_CURRENT_ADMIN_DEVICE");});
await test("Admin listing never returns keys, tokens or staff verification code",async()=>{const r=await call(admin,{action:"devices"});assert(r.items.every((x:any)=>!x.publicKey&&!x.vault&&!x.verificationCode));});
await test("CMS Admins cannot manage inventory or staff devices",async()=>{const b=browser();await login(b,"cms");await trustedBootstrap(b);await rejects(()=>call(b,{action:"devices"}),"ADMIN_REQUIRED");assert(!hasBusinessPermission(["Admins"],"inventory","read"));assert(hasBusinessPermission(["Admins"],"featureCms","write"));assert(!hasBusinessPermission(["ADMIN"],"featureCms","write"));});
await test("Viewer/editor/admin scope remains least privilege",async()=>{assert(hasBusinessPermission(["VIEWER"],"inventory","read"));assert(!hasBusinessPermission(["VIEWER"],"inventory","write"));assert(hasBusinessPermission(["EDITOR"],"inventory","write"));assert(!hasBusinessPermission(["EDITOR"],"inventory","admin"));assert(!hasBusinessPermission([],"inventory","read"));});
await test("Incomplete deployment evidence cannot enable production cutover",async()=>{assert(!cutoverReadiness({}).ready);assert.throws(()=>assertCutoverReady({realWindowsHelloPassed:{passed:true,evidence:""}}),/SECURITY_CUTOVER_BLOCKED/);});
await test("HTTP stores opaque session only in Secure HttpOnly cookie",async()=>{
 const b=browser(),r=await securityHttp(service,{method:"POST",path:"/api/security/login",headers:{origin,"content-type":"application/json"},ip:ctx.ip,body:JSON.stringify({username:"viewer",mode:"passkey",key:b.publicKey,name:"QA"})});
 assert.equal(r.statusCode,200);assert(r.cookies?.[0].startsWith(COOKIE+"="));assert(r.cookies?.[0].includes("HttpOnly; Secure; SameSite=Strict"));assert(!r.body.includes("sessionToken"));assert(!r.body.includes("refresh-"));assert.equal(r.headers["cache-control"],"no-store, private, max-age=0");
});
await test("HTTP untrusted origin rejected",async()=>{const r=await securityHttp(service,{method:"POST",path:"/api/security/login",headers:{origin:"https://evil.test","content-type":"application/json"},body:"{}",ip:ctx.ip});assert.equal(r.statusCode,403);});
await test("Audit contains no password, credential, raw token or key",async()=>{const rows=await store.list("event");for(const row of rows.items)for(const forbidden of ["password","credential","vault","privateKey","accessToken","refreshToken"])assert(!Object.hasOwn(row,forbidden));});
await test("Fresh passkey required for aged administrator control",async()=>{time+=301;await rejects(()=>call(admin,{action:"devices"}),"REAUTHENTICATE");});
await test("Reauthentication with same key does not require another approval",async()=>{await login(admin,"admin");assert.equal((await call(admin,{action:"status"})).approved,true);});
await test("Role demotion is enforced when Cognito tokens refresh",async()=>{const b=browser();await login(b,"admin");await trustedBootstrap(b);profiles.admin.groups=["EDITOR"];time+=301;await rejects(()=>call(b,{action:"devices"}),"ADMIN_REQUIRED");profiles.admin.groups=["ADMIN"];await login(admin,"admin");});
await test("Concurrent proof replay succeeds at most once",async()=>{const p=await proof(admin,{action:"status"}),r=await Promise.allSettled([service.perform(admin.token,p.payload,p.proof,ctx),service.perform(admin.token,p.payload,p.proof,ctx)]);assert.equal(r.filter(x=>x.status==="fulfilled").length,1);});
await test("Refresh outage does not bypass authentication or extend expiry",async()=>{const b=browser();await login(b,"cms");await trustedBootstrap(b);const before=await store.get<Row>("session#"+hash(b.token));time+=301;refreshFailure=true;await rejects(()=>call(b,{action:"businessProbe"}),"UPSTREAM_UNAVAILABLE");refreshFailure=false;assert.equal((await store.get<Row>("session#"+hash(b.token)))!.expiresAt,before!.expiresAt);await rejects(()=>call(b,{action:"businessProbe"}),"RETRY_LATER");time+=31;assert.equal((await call(b,{action:"businessProbe"})).ok,true);});
await test("Next-day personal session renews without login or approval",async()=>{
 const b=browser();await login(b,"viewer");await trustedBootstrap(b);time+=86400;assert.equal((await call(b,{action:"businessProbe"})).ok,true);assert(refreshCount>0);
});
await test("Shared device expires after 30 minute idle",async()=>{const b=browser();await login(b,"viewer","passkey",true);await trustedBootstrap(b);time+=1801;await rejects(()=>call(b,{action:"businessProbe"}),"SESSION_EXPIRED");});
await test("Account suspension invalidates all prior sessions",async()=>{await login(admin,"admin");const b=browser();await login(b,"viewer");await trustedBootstrap(b);const u=(await store.get<User>("user#viewer"))!;await call(admin,{action:"disableUser",sub:u.sub,expectedVersion:u.version});await rejects(()=>call(b,{action:"businessProbe"}),"ACCOUNT_DISABLED");await rejects(()=>login(browser(),"viewer"),"ACCOUNT_DISABLED");});
await test("Personal session has an absolute expiry, regardless of TTL deletion",async()=>{time+=31*86400;await rejects(()=>call(admin,{action:"businessProbe"}),"SESSION_EXPIRED");});
await test("Login attempts are rate limited",async()=>{for(let i=0;i<10;i++)await login(browser(),"admin");await rejects(()=>login(browser(),"admin"),"TOO_MANY_REQUESTS");});
await test("Store transactions never partially modify records on CAS error",async()=>{const a={id:"atomic-a",version:1},b={id:"atomic-b",version:1};await store.write([{row:a,expected:null},{row:b,expected:null}]);await rejects(()=>store.write([{row:{...a,version:2},expected:1},{row:{...b,version:2},expected:99}]),"STALE_RECORD");assert.equal((await store.get(a.id))?.version,1);});
console.log(JSON.stringify({passed,failed:0,hardwareBiometrics:"NOT_TESTED",productionChanged:false}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

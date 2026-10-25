/** Live protocol tests against ONLY the isolated pilot. Software authenticator, not biometric hardware. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
const awsPath="C:/Program Files/Amazon/AWSCLIV2/aws.exe";
const outputs=JSON.parse(fs.readFileSync("cdk.out/security/pilot-outputs.json","utf8")).BelloSecurityPilot20261026;
assert.equal(Object.keys(JSON.parse(fs.readFileSync("cdk.out/security/pilot-outputs.json","utf8"))).length,1);
const privateDir=path.join(process.env.LOCALAPPDATA!,"BELLO","security-pilot");
fs.mkdirSync(privateDir,{recursive:true});
function aws(service:string,operation:string,body:unknown,query?:string){
 const file=path.join(privateDir,"input-"+randomBytes(12).toString("hex")+".json");
 try{fs.writeFileSync(file,JSON.stringify(body),{mode:0o600});
  const args=[service,operation,"--profile","Bello","--region","us-west-2","--cli-input-json","file://"+file,"--output","json"];
  if(query)args.push("--query",query);
  return JSON.parse(execFileSync(awsPath,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]})||"{}");
 }catch{throw Error("AWS_FIXTURE_OPERATION_FAILED: "+service+" "+operation);}
 finally{if(fs.existsSync(file))fs.unlinkSync(file);}
}
function hash(v:Buffer|string){return createHash("sha256").update(v).digest();}
function cbor(v:any):Buffer{
 const head=(major:number,n:number):Buffer=>n<24?Buffer.from([major*32+n]):n<256?Buffer.from([major*32+24,n]):n<65536?Buffer.from([major*32+25,n>>8,n&255]):Buffer.from([major*32+26,n>>>24,(n>>>16)&255,(n>>>8)&255,n&255]);
 if(Buffer.isBuffer(v))return Buffer.concat([head(2,v.length),v]);
 if(typeof v==="string"){const b=Buffer.from(v);return Buffer.concat([head(3,b.length),b]);}
 if(typeof v==="number")return v>=0?head(0,v):head(1,-v-1);
 if(v instanceof Map)return Buffer.concat([head(5,v.size),...[...v].flatMap(([k,x])=>[cbor(k),cbor(x)])]);
 throw Error("Unsupported fixture CBOR");
}
function browser(){
 const key=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),passkey=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
 return{key,passkey,cookie:"",username:"",password:"",userId:"",credentialId:randomBytes(32),counter:0};
}
type Browser=ReturnType<typeof browser>;
const origin=outputs.Origin,host=new URL(origin).hostname;
const results:{name:string,result:string,ms:number}[]=[];
async function post(b:Browser,p:string,body:unknown,expected=200,requestOrigin=origin){
 const r=await fetch(origin+p,{method:"POST",headers:{"content-type":"application/json",origin:requestOrigin,...(b.cookie?{cookie:b.cookie}:{})},body:JSON.stringify(body),redirect:"error"});
 const j=await r.json() as any;
 if(r.status!==expected)throw Error("HTTP "+r.status+" at "+p+" code="+j.error);
 const cookies=r.headers.getSetCookie();if(cookies[0]){assert(cookies[0].includes("HttpOnly; Secure; SameSite=Strict"));b.cookie=cookies[0].split(";")[0];}
 assert(!JSON.stringify(j).includes("AccessToken"));assert(!JSON.stringify(j).includes("RefreshToken"));
 return j;
}
async function action(b:Browser,body:unknown,expected=200){
 const payload=JSON.stringify(body),c=await post(b,"/api/security/challenge",{digest:hash(payload).toString("base64url")},expected===401?401:200);
 if(expected===401)return c;
 const signature=sign("sha256",Buffer.from(c.message),{key:b.key.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
 return post(b,"/api/security/action",{payload,proof:{challengeId:c.challengeId,signature}},expected);
}
async function passwordLogin(b:Browser){await post(b,"/api/security/login",{username:b.username,password:b.password,mode:"password",name:"Protocol QA",key:b.key.publicKey.export({format:"jwk"}),shared:false});}
async function enroll(b:Browser){
 const r=await action(b,{action:"enrollStart"}),o=typeof r.options==="string"?JSON.parse(r.options):r.options;
 assert.equal(o.rp.id,host);assert.equal(o.authenticatorSelection.userVerification,"required");b.userId=o.user.id;
 const pub=b.passkey.publicKey.export({format:"jwk"});
 const cose=cbor(new Map<any,any>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(pub.x!,"base64url")],[-3,Buffer.from(pub.y!,"base64url")]]));
 const authData=Buffer.concat([hash(host),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,b.credentialId.length]),b.credentialId,cose]);
 const clientDataJSON=Buffer.from(JSON.stringify({type:"webauthn.create",challenge:o.challenge,origin,crossOrigin:false})).toString("base64url");
 const attestationObject=cbor(new Map<any,any>([["fmt","none"],["attStmt",new Map()],["authData",authData]])).toString("base64url");
 await action(b,{action:"enrollFinish",credential:{id:b.credentialId.toString("base64url"),rawId:b.credentialId.toString("base64url"),type:"public-key",authenticatorAttachment:"platform",clientExtensionResults:{},response:{clientDataJSON,attestationObject,transports:["internal"]}}});
}
async function passkeyLogin(b:Browser){
 const r=await post(b,"/api/security/login",{username:b.username,mode:"passkey",key:b.key.publicKey.export({format:"jwk"}),name:"Protocol QA",shared:false});
 assert.equal(r.step,"WEB_AUTHN");const o=r.options;assert.equal(o.rpId,host);
 const clientData=Buffer.from(JSON.stringify({type:"webauthn.get",challenge:o.challenge,origin,crossOrigin:false}));
 const counter=Buffer.alloc(4);counter.writeUInt32BE(++b.counter);
 const authData=Buffer.concat([hash(host),Buffer.from([0x05]),counter]);
 const signature=sign("sha256",Buffer.concat([authData,hash(clientData)]),b.passkey.privateKey).toString("base64url");
 await post(b,"/api/security/finish",{flowToken:r.flowToken,answer:{id:b.credentialId.toString("base64url"),rawId:b.credentialId.toString("base64url"),type:"public-key",authenticatorAttachment:"platform",clientExtensionResults:{},response:{clientDataJSON:clientData.toString("base64url"),authenticatorData:authData.toString("base64url"),signature,userHandle:b.userId}}});
}
function createUser(b:Browser,role:string){
 b.username="qa-"+role.toLowerCase()+"-"+Date.now()+"@bello.invalid";b.password="Qa1!"+randomBytes(24).toString("base64url");
 const r=aws("cognito-idp","admin-create-user",{UserPoolId:outputs.PoolId,Username:b.username,MessageAction:"SUPPRESS",UserAttributes:[{Name:"email",Value:b.username},{Name:"email_verified",Value:"true"}]});
 const sub=r.User.Attributes.find((a:any)=>a.Name==="sub").Value;
 aws("cognito-idp","admin-set-user-password",{UserPoolId:outputs.PoolId,Username:b.username,Password:b.password,Permanent:true});
 aws("cognito-idp","admin-add-user-to-group",{UserPoolId:outputs.PoolId,Username:b.username,GroupName:role});
 return sub;
}
async function test(name:string,fn:()=>Promise<void>){const start=performance.now();await fn();results.push({name,result:"PASS",ms:Math.round(performance.now()-start)});console.log("PASS "+name);}
async function main(){
 const pool=aws("cognito-idp","describe-user-pool",{UserPoolId:outputs.PoolId},"UserPool.Name");
 assert.equal(pool,"bello-security-pilot-20261026");
 const secret=aws("cognito-idp","describe-user-pool-client",{UserPoolId:outputs.PoolId,ClientId:outputs.ClientId},"UserPoolClient.ClientSecret");
 aws("secretsmanager","put-secret-value",{SecretId:outputs.SecretArn,SecretString:JSON.stringify({clientSecret:secret})},"ARN");
 const admin=browser(),staff=browser(),created:Browser[]=[];
 try{
 const adminSub=createUser(admin,"ADMIN");created.push(admin);const staffSub=createUser(staff,"EDITOR");created.push(staff);
 await test("Cognito first sign-in: encrypted bootstrap session",()=>passwordLogin(admin));
 await test("Cognito WebAuthn registration (software authenticator)",()=>enroll(admin));
 await test("Cognito passkey login (software authenticator)",()=>passkeyLogin(admin));
 await test("Authenticated administrator still blocked before device approval",async()=>{const r=await action(admin,{action:"businessProbe"},403);assert.equal(r.error,"DEVICE_PENDING");});
 // Test-only initial admin bootstrapping using AWS operator credentials. Not an HTTP bypass.
 const keyJson=admin.key.publicKey.export({format:"jwk"});
 const keyId=hash(JSON.stringify({kty:"EC",crv:"P-256",x:keyJson.x,y:keyJson.y})).toString("base64url");
 const adminDeviceId="device#"+adminSub+"#"+keyId;
 aws("dynamodb","update-item",{TableName:outputs.Table,Key:{id:{S:adminDeviceId}},UpdateExpression:"SET #s = :approved, #v = #v + :one",ConditionExpression:"#s = :pending",ExpressionAttributeNames:{"#s":"status","#v":"version"},ExpressionAttributeValues:{":approved":{S:"approved"},":pending":{S:"pending"},":one":{N:"1"}}});
 await test("Approved admin can access protected probe",async()=>{assert.equal((await action(admin,{action:"businessProbe"})).ok,true);});
 await test("Staff initial sign-in and enrollment",async()=>{await passwordLogin(staff);await enroll(staff);await passkeyLogin(staff);});
 await test("Pending staff cannot read protected probe",async()=>{assert.equal((await action(staff,{action:"businessProbe"},403)).error,"DEVICE_PENDING");});
 await test("Device list redacts key, token and staff verification code",async()=>{const r=await action(admin,{action:"devices"});assert(r.items.every((x:any)=>!x.publicKey&&!x.vault&&!x.verificationCode));});
 let target:any;
 await test("Approve staff after checking request code",async()=>{const staffStatus=await action(staff,{action:"status"});target=(await action(admin,{action:"devices"})).items.find((x:any)=>x.sub===staffSub&&x.status==="pending");assert(target);await action(admin,{action:"approve",deviceId:target.id,expectedVersion:target.version,verificationCode:staffStatus.verificationCode,personConfirmed:true});});
 await test("Existing staff session becomes approved",async()=>{assert.equal((await action(staff,{action:"businessProbe"})).ok,true);});
 await test("Staff cannot call admin device management",async()=>{assert.equal((await action(staff,{action:"devices"},403)).error,"ADMIN_REQUIRED");});
 await test("Stolen cookie without matching key denied",async()=>{const attacker=browser();attacker.cookie=staff.cookie;assert.equal((await action(attacker,{action:"businessProbe"},403)).error,"INVALID_DEVICE_PROOF");});
 await test("Cross-origin request denied",async()=>{const r=await post(staff,"/api/security/challenge",{digest:hash("x").toString("base64url")},403,"https://evil.invalid");assert.equal(r.error,"INVALID_ORIGIN");});
 await test("Device revocation blocks already-issued cookie",async()=>{target=(await action(admin,{action:"devices"})).items.find((x:any)=>x.id===target.id);await action(admin,{action:"revoke",deviceId:target.id,expectedVersion:target.version});const r=await post(staff,"/api/security/challenge",{digest:hash("x").toString("base64url")},403);assert.equal(r.error,"DEVICE_REVOKED");});
 await test("Database token contents encrypted",async()=>{
 const r=aws("dynamodb","scan",{TableName:outputs.Table,FilterExpression:"#k = :k",ExpressionAttributeNames:{"#k":"kind"},ExpressionAttributeValues:{":k":{S:"session"}},Limit:100});
 assert(r.Items.length);for(const row of r.Items){const v=JSON.parse(row.vault.S);assert.equal(v.v,1);assert(v.key&&v.data&&!v.refresh&&!v.access);}
 });
 await test("Admin logout invalidates session",async()=>{await action(admin,{action:"logout"});await post(admin,"/api/security/challenge",{digest:hash("x").toString("base64url")},401);});
 }finally{
   for(const b of created)aws("cognito-idp","admin-disable-user",{UserPoolId:outputs.PoolId,Username:b.username});
   // No fixture passwords, private keys, cookies or tokens are written to the report.
   fs.mkdirSync("artifacts/security-20261026",{recursive:true});
   fs.writeFileSync("artifacts/security-20261026/live-results.json",JSON.stringify({origin,results,hardwareBiometrics:"NOT_TESTED",businessDataConnected:false,productionChanged:false,testAccountsDisabled:true},null,2));
 }
}
main().catch(e=>{console.error(String(e.message));process.exitCode=1;});

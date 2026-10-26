/** Live protocol tests against ONLY the isolated pilot. Software authenticator, not biometric hardware. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {randomUUID} from 'node:crypto';
import {requestProofMessage} from '../lib/security/requestProof';
import {KmsVault} from '../lib/security/awsVault';
import {CognitoProvider} from '../lib/security/cognito';
import {PhotoRegistrationApiClient,uploadSession,describeFile} from '../tools/bello-photo-station/src/client.mjs';
import {windowsDeviceProof} from '../tools/bello-photo-station/src/deviceProof.mjs';
import sharp from 'sharp';
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
 const r=await fetch(origin+p,{method:"POST",headers:{"content-type":"application/json",origin:requestOrigin,...(b.cookie?{cookie:b.cookie}:{})},body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(40000)});
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
async function business(b:Browser,method:string,target:string,body?:unknown,expected=200,binding?:string){
 const raw=body===undefined?'':JSON.stringify(body),status=binding?{requestBinding:binding}:await action(b,{action:'status'});
 const p={version:1 as const,at:Math.floor(Date.now()/1000),nonce:randomBytes(32).toString('base64url'),binding:status.requestBinding,digest:hash(raw).toString('base64url')};
 const signature=sign('sha256',Buffer.from(requestProofMessage(origin,method,target,p)),{key:b.key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 const r=await fetch(origin+target,{method,headers:{origin,cookie:b.cookie,'content-type':'application/json','x-bello-device-proof':JSON.stringify({...p,signature})},...(method==='GET'?{}:{body:raw}),signal:AbortSignal.timeout(40000)});
 const result=await r.json() as any;assert.equal(r.status,expected,'business status: '+JSON.stringify(result));return result;
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
async function test(name:string,fn:()=>Promise<void>){const start=performance.now();try{await fn();results.push({name,result:"PASS",ms:Math.round(performance.now()-start)});console.log("PASS "+name);}catch(error){results.push({name,result:"FAIL",ms:Math.round(performance.now()-start)});throw error;}}
async function main(){
 const pool=aws("cognito-idp","describe-user-pool",{UserPoolId:outputs.PoolId},"UserPool.Name");
 assert.equal(pool,"bello-security-pilot-20261026");
 const secret=aws("cognito-idp","describe-user-pool-client",{UserPoolId:outputs.PoolId,ClientId:outputs.ClientId},"UserPoolClient.ClientSecret");
 aws("secretsmanager","put-secret-value",{SecretId:outputs.SecretArn,SecretString:JSON.stringify({clientSecret:secret,contextKey:randomBytes(32).toString('base64url')})},"ARN");
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
 await test("Pending staff cannot create an actual inventory record",async()=>{assert.equal((await business(staff,'POST','/api/business/inventory',{name:'SECURITY QA pending',quantity:5},403)).error,'DEVICE_PENDING');});
 await test("Device list redacts key, token and staff verification code",async()=>{const r=await action(admin,{action:"devices"});assert(r.items.every((x:any)=>!x.publicKey&&!x.vault&&!x.verificationCode));});
 let target:any;
 await test("Approve staff after checking request code",async()=>{const staffStatus=await action(staff,{action:"status"});target=(await action(admin,{action:"devices"})).items.find((x:any)=>x.sub===staffSub&&x.status==="pending");assert(target);await action(admin,{action:"approve",deviceId:target.id,expectedVersion:target.version,verificationCode:staffStatus.verificationCode,personConfirmed:true});});
 await test("Existing staff session becomes approved",async()=>{assert.equal((await action(staff,{action:"businessProbe"})).ok,true);});
 let source:any,splitResult:any;
 await test("Approved staff creates actual isolated inventory through existing persistence core",async()=>{source=(await business(staff,'POST','/api/business/inventory',{name:'SECURITY QA stock',quantity:5})).value;assert(source.id);});
 await test('Direct AppSync access denied even with a valid staff JWT; public API key cannot read inventory',async()=>{
   // Operator-only attack fixture: unwrap this test user's own server vault.
   // Tokens and the server-origin secret are never printed or written to evidence.
   const sessionId='session#'+hash(staff.cookie.split('=')[1]).toString('base64url');
   const row=aws('dynamodb','get-item',{TableName:outputs.Table,Key:{id:{S:sessionId}},ConsistentRead:true}).Item;
   const vault=new KmsVault(outputs.KeyArn,'us-west-2','BelloSecurityPilot20261026');
   const token=await vault.open<{id:string}>(row.vault.S);
   const apiKey=aws('appsync','list-api-keys',{apiId:outputs.ProtectedGraphqlId}).apiKeys[0].id;
   const body=JSON.stringify({query:'query($id:ID!){getInventory(id:$id){id quantity}}',variables:{id:source.id}});
   for(const headers of [{Authorization:token.id},{'x-api-key':apiKey},{Authorization:token.id,'x-bello-data-gate':'wrong'}] as Record<string,string>[]){
     const r=await fetch(outputs.ProtectedGraphqlUrl,{method:'POST',headers:{'content-type':'application/json',...headers},body});assert.equal(r.status,403);
   }
   const gate=JSON.parse(aws('secretsmanager','get-secret-value',{SecretId:outputs.DataGateSecretArn}).SecretString).value;
   const r=await fetch(outputs.ProtectedGraphqlUrl,{method:'POST',headers:{'content-type':'application/json','x-api-key':apiKey,'x-bello-data-gate':gate},body});
   const result=await r.json() as any;assert(result.errors?.length);assert(!result.data?.getInventory);
 });
 await test("Real stock split transaction preserves 5 = 3 + 2 and separate titles",async()=>{
   const request={mutationId:randomUUID(),inventoryId:source.id,expectedUpdatedAt:source.updatedAt,quantity:2,sourceName:'SECURITY QA remaining',splitName:'SECURITY QA separated',damageNotes:'test',barcode:'SHARED',photos:[]};
   splitResult=(await business(staff,'POST','/api/business/inventory/split',request)).value;
   const remaining=(await business(staff,'GET','/api/business/inventory/'+source.id)).value;
   const separated=(await business(staff,'GET','/api/business/inventory/'+splitResult.splitId)).value;
   assert.equal(remaining.quantity,3);assert.equal(separated.quantity,2);assert.equal(remaining.name,request.sourceName);assert.equal(separated.name,request.splitName);
   const retry=(await business(staff,'POST','/api/business/inventory/split',request)).value;assert.equal(retry.splitId,splitResult.splitId);
   assert.equal((await business(staff,'GET','/api/business/inventory/'+source.id)).value.quantity,3);
 });
 const businessBinding=(await action(staff,{action:'status'})).requestBinding;
 await test("Staff cannot call admin device management",async()=>{assert.equal((await action(staff,{action:"devices"},403)).error,"ADMIN_REQUIRED");});
 await test("Stolen cookie without matching key denied",async()=>{const attacker=browser();attacker.cookie=staff.cookie;assert.equal((await action(attacker,{action:"businessProbe"},403)).error,"INVALID_DEVICE_PROOF");});
 await test("Cross-origin request denied",async()=>{const r=await post(staff,"/api/security/challenge",{digest:hash("x").toString("base64url")},403,"https://evil.invalid");assert.equal(r.error,"INVALID_ORIGIN");});
 const revokedStaff={...staff}; // Preserve the stolen-cookie attack fixture even after browser cleanup.
 await test("Device revocation blocks already-issued cookie and clears browser session",async()=>{target=(await action(admin,{action:"devices"})).items.find((x:any)=>x.id===target.id);await action(admin,{action:"revoke",deviceId:target.id,expectedVersion:target.version});const r=await post(staff,"/api/security/challenge",{digest:hash("x").toString("base64url")},403);assert.equal(r.error,"DEVICE_REVOKED");assert.equal(staff.cookie,'__Host-bello-session=');});
 await test("Revocation denies actual inventory read using the old cookie and valid private key",async()=>{assert.equal((await business(revokedStaff,'GET','/api/business/inventory/'+source.id,undefined,403,businessBinding)).error,'DEVICE_REVOKED');});
 await test("Revocation denies stock mutation and leaves stored quantity unchanged",async()=>{
   await business(revokedStaff,'POST','/api/business/inventory/split',{mutationId:randomUUID(),inventoryId:source.id,quantity:1},403,businessBinding);
   assert.equal((await business(admin,'GET','/api/business/inventory/'+source.id)).value.quantity,3);
 });
 await test("Database token contents encrypted",async()=>{
 const r=aws("dynamodb","scan",{TableName:outputs.Table,FilterExpression:"#k = :k",ExpressionAttributeNames:{"#k":"kind"},ExpressionAttributeValues:{":k":{S:"session"}},Limit:100});
 assert(r.Items.length);for(const row of r.Items){const v=JSON.parse(row.vault.S);assert.equal(v.v,1);assert(v.key&&v.data&&!v.refresh&&!v.access);}
 });
 const newStaff=browser();newStaff.username='qa-provision-'+Date.now()+'@bello.invalid';
 await test('Admin creates staff without sending an invitation or exposing tokens',async()=>{
   await passkeyLogin(admin);
   const result=await action(admin,{action:'createUser',username:newStaff.username,role:'VIEWER',personConfirmed:true});
   assert(result.temporaryPassword.length>=14);newStaff.password=result.temporaryPassword;created.push(newStaff);
   const duplicate=await action(admin,{action:'createUser',username:newStaff.username,role:'VIEWER',personConfirmed:true},409);assert.equal(duplicate.error,'STALE_RECORD');
 });
 await test('Staff creation cannot grant administrator privileges',async()=>{assert.equal((await action(admin,{action:'createUser',username:'qa-invalid@bello.invalid',role:'ADMIN',personConfirmed:true},400)).error,'INVALID_STAFF_INPUT');});
 await test('Created staff must change temporary password and enroll; still no business access',async()=>{
   const login=await post(newStaff,'/api/security/login',{username:newStaff.username,password:newStaff.password,mode:'password',key:newStaff.key.publicKey.export({format:'jwk'}),name:'New staff QA',shared:false});
   assert.equal(login.step,'NEW_PASSWORD_REQUIRED');newStaff.password='Qa1!'+randomBytes(24).toString('base64url');
   await post(newStaff,'/api/security/finish',{flowToken:login.flowToken,answer:newStaff.password});
   await enroll(newStaff);await passkeyLogin(newStaff);assert.equal((await action(newStaff,{action:'businessProbe'},403)).error,'DEVICE_PENDING');
 });
 const photo=browser();const photoSub=createUser(photo,'PHOTO_DEVICE');created.push(photo);
 const login=await new CognitoProvider(outputs.PoolId,outputs.ClientId,'us-west-2',secret).start(photo.username,'password',photo.password);
 assert(login.identity);const machineToken=login.identity.tokens.id;
 process.env.BELLO_DEVICE_SIGNER_EXE??=path.resolve('tools/bello-photo-station/windows/src/PhotoStation.Desktop/bin/Release/net10.0-windows/PhotoStation.Desktop.exe');
 const machineApi=new PhotoRegistrationApiClient({endpoint:origin+'/photo',tokenProvider:async()=>machineToken,deviceProofProvider:windowsDeviceProof,retries:0});
 let registration:any,original:any,photoResult:any;
 await test('PhotoStation: a valid JWT alone cannot access images',async()=>{const api=new PhotoRegistrationApiClient({endpoint:origin+'/photo',tokenProvider:async()=>machineToken,retries:0});await assert.rejects(()=>api.call('createPhotoBatch',{}));});
 await test('PhotoStation: real Windows key registers pending; upload is denied',async()=>{registration=await machineApi.call('registerDevice',{name:'Windows security QA'});assert(registration.pending);await assert.rejects(()=>machineApi.call('createPhotoBatch',{localImportSessionId:randomUUID(),sourceDeviceId:registration.deviceId,expectedAssetCount:1,imageCountOriginal:1}),(e:any)=>e.code==='DEVICE_PENDING');});
 await test('PhotoStation: admin approves the actual Windows key',async()=>{const d=(await action(admin,{action:'devices'})).items.find((x:any)=>x.sub===photoSub);assert(d?.machine);await action(admin,{action:'approve',deviceId:d.id,expectedVersion:d.version,verificationCode:registration.verificationCode,personConfirmed:true});assert.equal((await machineApi.call('registerDevice',{})).pending,false);});
 const photoDir=path.resolve('artifacts/security-20261026/photo-fixture');fs.mkdirSync(photoDir,{recursive:true});
 const imagePath=path.join(photoDir,'synthetic-security-test.jpg');const thumbPath=path.join(photoDir,'synthetic-security-test-thumb.jpg');
 await sharp({create:{width:640,height:480,channels:3,background:{r:36,g:75,b:100}}}).jpeg({quality:95}).toFile(imagePath);
 await sharp(imagePath).resize(160,120).jpeg().toFile(thumbPath);
 const originalDescription={...await describeFile(imagePath,'application/octet-stream'),fileName:'synthetic-security-test.jpg'};
 const sessionId=randomUUID();
 await test('PhotoStation: approved import stores the byte-identical original in isolated S3',async()=>{original=await machineApi.call('requestTemporaryOriginal',{sessionId,clientAssetId:'qa-1',importedAt:new Date().toISOString(),original:originalDescription});assert.equal(original.status,'UPLOAD');await machineApi.upload(original.upload,imagePath);assert.equal((await machineApi.call('completeTemporaryOriginal',{id:original.id})).status,'READY');const h=aws('s3api','head-object',{Bucket:outputs.FixturePhotoBucket,Key:'photo-batches/original-imports/'+original.id+'.bin',ChecksumMode:'ENABLED'});assert.equal(h.ContentLength,originalDescription.fileSize);assert.equal(h.ChecksumSHA256,Buffer.from(originalDescription.sha256,'hex').toString('base64'));});
 const uploadInput={api:machineApi,deviceId:registration.deviceId,sessionId,assets:[{clientAssetId:'qa-1',fileName:'synthetic-security-test.jpg',originalPath:imagePath,originalArchiveId:original?.id,processedPath:imagePath,thumbnailPath:thumbPath,processedDimensions:{width:640,height:480},thumbnailDimensions:{width:160,height:120}}]};
 await test('PhotoStation: processed image and thumbnail complete through the real client',async()=>{photoResult=await uploadSession(uploadInput);assert.equal(photoResult.uploaded,1);});
 await test('PhotoStation: retry does not create a duplicate batch',async()=>{const retry=await uploadSession(uploadInput);assert.equal(retry.batchId,photoResult.batchId);});
 await test('PhotoStation: stolen JWT on another key cannot access the approved machine',async()=>{const otherKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const api=new PhotoRegistrationApiClient({endpoint:origin+'/photo',tokenProvider:async()=>machineToken,retries:0,deviceProofProvider:async({url,method,body}:any)=>{const u=new URL(url),p={version:1 as const,at:Math.floor(Date.now()/1000),nonce:randomBytes(32).toString('base64url'),binding:hash('photo#'+photoSub).toString('base64url'),digest:hash(body).toString('base64url')};const signature=sign('sha256',Buffer.from(requestProofMessage(u.origin,method,u.pathname+u.search,p)),{key:otherKey.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');return{'x-bello-device-key':JSON.stringify(otherKey.publicKey.export({format:'jwk'})),'x-bello-device-proof':JSON.stringify({...p,signature})};}});await assert.rejects(()=>api.call('completeTemporaryOriginal',{id:original.id}),(e:any)=>e.code==='DEVICE_REGISTRATION_REQUIRED');});
 await test('PhotoStation: revoke blocks the same Windows key and already-issued JWT',async()=>{const d=(await action(admin,{action:'devices'})).items.find((x:any)=>x.sub===photoSub);await action(admin,{action:'revoke',deviceId:d.id,expectedVersion:d.version});await assert.rejects(()=>machineApi.call('completeTemporaryOriginal',{id:original.id}),(e:any)=>e.code==='DEVICE_REVOKED');});
 await test("Admin logout invalidates session",async()=>{await action(admin,{action:"logout"});await post(admin,"/api/security/challenge",{digest:hash("x").toString("base64url")},401);});
 }finally{
   for(const b of created){aws("cognito-idp","admin-disable-user",{UserPoolId:outputs.PoolId,Username:b.username});
     const user=aws('cognito-idp','admin-get-user',{UserPoolId:outputs.PoolId,Username:b.username});const sub=user.UserAttributes.find((a:any)=>a.Name==='sub').Value;
     aws('dynamodb','update-item',{TableName:outputs.Table,Key:{id:{S:'user#'+sub}},UpdateExpression:'SET enabled=:no, generation=if_not_exists(generation,:zero)+:one',ExpressionAttributeValues:{':no':{BOOL:false},':zero':{N:'0'},':one':{N:'1'}}});}
   // No fixture passwords, private keys, cookies or tokens are written to the report.
   fs.mkdirSync("artifacts/security-20261026",{recursive:true});
   fs.writeFileSync("artifacts/security-20261026/live-results.json",JSON.stringify({origin,results,hardwareBiometrics:"NOT_TESTED",businessDataConnected:'isolated-fixture-tables',productionChanged:false,testAccountsDisabled:true},null,2));
 }
}
main().catch(e=>{console.error(String(e.message),e.cause?.code??'');process.exitCode=1;});

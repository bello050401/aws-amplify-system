/** Prepare a LOOPBACK-ONLY full BELLO regression copy. Never deploy these fixture routes. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
if(!root.replaceAll('\\','/').endsWith('/.cache/bello-security-20261026/build'))throw Error('Private build copy only');
const stage=Object.values(JSON.parse(fs.readFileSync('cdk.out/security-business/stage-outputs.json','utf8')))[0];
const pilot=JSON.parse(fs.readFileSync('cdk.out/security/pilot-outputs.json','utf8')).BelloSecurityPilot20261026;
if(stage.awsAppsyncApiId!=='yau3id5kzjepfbr6b7wt42nstq'||pilot.PoolId!=='us-west-2_JUoq4susA')throw Error('Isolated AWS resources only');
const outputs=JSON.parse(fs.readFileSync('artifacts/security-20261026/business-outputs/amplify_outputs.json','utf8'));
if(outputs.data.url!==stage.IsolatedGraphqlUrl||outputs.storage.bucket_name!==stage.IsolatedBucket)throw Error('Wrong stage outputs');
fs.writeFileSync('amplify_outputs.json',JSON.stringify(outputs,null,2));
const tables=JSON.parse(stage.IsolatedTables);
const mode=process.argv[2]||'build';
const env={...process.env,AWS_PROFILE:'Bello',AWS_REGION:'us-west-2',BELLO_DEVICE_SECURITY:'enforced',
 SECURITY_REGION:'us-west-2',SECURITY_TABLE:pilot.Table,SECURITY_KEY_ARN:pilot.KeyArn,SECURITY_DEPLOYMENT:'bello-security-pilot-20261026',
 SECURITY_POOL_ID:pilot.PoolId,SECURITY_CLIENT_ID:pilot.ClientId,SECURITY_CLIENT_SECRET_ARN:pilot.SecretArn,
 SECURITY_ORIGIN:'http://localhost:4319',SECURITY_APPSYNC_GATE_SECRET_ARN:pilot.DataGateSecretArn,
 CONVERSATION_TABLE_NAME:tables.Conversation,MESSAGE_TABLE_NAME:tables.Message,BELLO_MOBILE_WRITES_ENABLED:'true',BELLO_MOBILE_PUBLIC_ORIGIN:'http://localhost:4319',
 PHOTO_REGISTRATION_TABLE_NAME:pilot.FixturePhotoTable,PHOTO_REGISTRATION_INVENTORY_TABLE_NAME:tables.Inventory,PHOTO_REGISTRATION_BUCKET_NAME:pilot.FixturePhotoBucket,PHOTO_REGISTRATION_AWS_REGION:'us-west-2'};
if(!env.SECURITY_KEY_ARN)throw Error('Pilot key output missing');
for(const k of Object.keys(env))if(/(ZAICO|ECONVENI|MERCARI|MONEYFORWARD|GMAIL|BASE_)/.test(k))delete env[k];
if(mode==='start'){
 if(!stage.IsolatedBrowserRoleArn?.startsWith('arn:aws:iam::203918843421:role/amplify-bellosecuritybusi-'))throw Error('Restricted stage role missing');
 const credentials=JSON.parse(cp.execFileSync('C:/Program Files/Amazon/AWSCLIV2/aws.exe',['sts','assume-role','--profile','Bello','--role-arn',stage.IsolatedBrowserRoleArn,'--role-session-name','security-browser-regression','--duration-seconds','3600','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})).Credentials;
 delete env.AWS_PROFILE;delete env.AWS_DEFAULT_PROFILE;
 env.AWS_ACCESS_KEY_ID=credentials.AccessKeyId;env.AWS_SECRET_ACCESS_KEY=credentials.SecretAccessKey;env.AWS_SESSION_TOKEN=credentials.SessionToken;
}
const put=(name,body)=>{fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,body)};
put('app/security-stage-fixture/route.ts',`
import {NextRequest,NextResponse} from 'next/server';
import {CognitoIdentityProviderClient,AdminCreateUserCommand,AdminSetUserPasswordCommand,AdminAddUserToGroupCommand,AdminDisableUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import {randomBytes} from 'node:crypto';
import {securityRuntime} from '@/lib/security/serverRuntime';
import {SecurityService} from '@/lib/security/service';
import {hash} from '@/lib/security/crypto';
import type {Session,Device} from '@/lib/security/types';
export async function POST(request:NextRequest){
 if(request.nextUrl.origin!=='http://localhost:4319'||request.headers.get('origin')!=='http://localhost:4319'||process.env.SECURITY_POOL_ID!=='us-west-2_JUoq4susA')return new Response('denied',{status:403});
 const input=await request.json(),{service}=await securityRuntime();
 if(input.operation==='revoke'){
  const token=request.cookies.get('__Host-bello-session')?.value??'';
  const s=await service.store.get<Session>('session#'+hash(token));
  if(!s)return new Response('no session',{status:401});
  const d=await service.store.get<Device>(s.deviceId);
  if(d)await service.store.write([{expected:d.version,row:{...d,version:d.version+1,status:'revoked',generation:d.generation+1}}]);
  return Response.json({revoked:true});
 }
 if(!['ADMIN','EDITOR','VIEWER','Admins'].includes(input.role))return new Response('role',{status:400});
 const cognito=new CognitoIdentityProviderClient({region:'us-west-2'}),username='qa-business-'+Date.now()+'@bello.invalid',password='Qa1!'+randomBytes(24).toString('base64url'),UserPoolId='us-west-2_JUoq4susA';
 await cognito.send(new AdminCreateUserCommand({UserPoolId,Username:username,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:username},{Name:'email_verified',Value:'true'}]}));
 try{
 await cognito.send(new AdminSetUserPasswordCommand({UserPoolId,Username:username,Password:password,Permanent:true}));
 await cognito.send(new AdminAddUserToGroupCommand({UserPoolId,Username:username,GroupName:input.role}));
 const auth=await service.provider.start(username,'password',password);
 if(!auth.identity)throw Error('No identity');
 // UI regression fixture, NOT a biometric/passkey test. The separate live
 // protocol suite tests Cognito WebAuthn. Real request signing/roles remain on.
 const provider=Object.create(service.provider);provider.start=async()=>({identity:auth.identity});provider.hasPasskey=async()=>true;
 const setup=new SecurityService(service.store,service.vault,provider,service.origin);
 const result=await setup.begin({username,mode:'passkey',key:input.key,name:'Full BELLO UI fixture',shared:false},{origin:service.origin,ip:'127.0.0.1',userAgent:'loopback-regression-fixture'});
 const session=await service.store.get<Session>('session#'+hash(result.sessionToken!));
 const device=await service.store.get<Device>(session!.deviceId);
 await service.store.write([{expected:device!.version,row:{...device!,version:device!.version+1,status:input.pending?'pending':'approved'}}]);
 return NextResponse.json({binding:hash(session!.id),username,role:input.role,biometrics:false},{headers:{'set-cookie':'__Host-bello-session='+result.sessionToken+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800','cache-control':'no-store'}});
 }catch(error){await cognito.send(new AdminDisableUserCommand({UserPoolId,Username:username}));throw error;}
}
`);
put('public/security-stage-fixture.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><title>BELLO隔離検証</title><h1>実BELLO画面の隔離検証</h1><p>在庫・画像は検証専用AWS。本番データ・ECへの接続なし。本人認証だけ検証用代替処理。</p><select id="role"><option>ADMIN</option><option>EDITOR</option><option>VIEWER</option><option>Admins</option></select><label><input type="checkbox" id="pending">未承認</label><button id="prepare">検証アカウントで開く</button><button id="revoke">この端末の承認を解除</button><a href="/inventory">在庫画面</a><a href="/staff-app/index.html">iPhone用画面</a><a href="http://localhost:4319/api/base/oauth/callback?state=security-qa-invalid&code=security-qa-invalid">別サイトからの認証復帰検証（無効な照合値）</a><pre id="result"></pre><script src="/security-stage-fixture.js"></script></html>`);
put('public/security-stage-fixture.js',`
const result=document.querySelector('#result');
const save=async(k,v)=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('bello-approved-browser-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('settings');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});await new Promise((res,rej)=>{const t=db.transaction('settings','readwrite');t.objectStore('settings').put(v,k);t.oncomplete=res;t.onerror=rej});db.close()};
document.querySelector('#prepare').onclick=async()=>{try{result.textContent='隔離環境のアカウントを準備中…';const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);const r=await fetch('/security-stage-fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:document.querySelector('#role').value,pending:document.querySelector('#pending').checked,key:await crypto.subtle.exportKey('jwk',key.publicKey)})});if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();await save('keyPair',key);await save('requestBinding',data.binding);await navigator.serviceWorker.register('/security-worker.js',{scope:'/'});await navigator.serviceWorker.ready;result.textContent='準備完了 '+data.role+'。在庫画面を開いてください。';}catch(e){result.textContent=e.message}};
document.querySelector('#revoke').onclick=async()=>{const r=await fetch('/security-stage-fixture',{method:'POST',headers:{'content-type':'application/json'},body:'{"operation":"revoke"}'});result.textContent=r.status+' 承認解除。業務画面で拒否を確認してください。'};
`);
if(mode==='build')process.exitCode=cp.spawnSync(process.execPath,['node_modules/next/dist/bin/next','build'],{cwd:root,env,stdio:'inherit'}).status??1;
else if(mode==='start')process.exitCode=cp.spawnSync(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','4319'],{cwd:root,env,stdio:'inherit'}).status??1;
else throw Error('Unknown mode');

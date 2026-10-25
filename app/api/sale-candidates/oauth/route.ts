import {NextResponse} from 'next/server';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {GetCommand,PutCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {GetSecretValueCommand,PutSecretValueCommand,SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb} from '@/lib/inventory/categoryPersistence';
import {candidateConfig} from '@/lib/saleCandidates/store';
import {NO_STORE} from '@/lib/invoicing/gateway';
export const dynamic='force-dynamic';
const ORIGIN='https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com',CALLBACK=ORIGIN+'/api/sale-candidates/oauth',SCOPE='https://www.googleapis.com/auth/gmail.readonly';
const sm=new SecretsManagerClient({region:process.env.AWS_REGION||'us-west-2'}),secretId='bello/gmail-oauth',hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function settings(){const s=await sm.send(new GetSecretValueCommand({SecretId:secretId}));return JSON.parse(s.SecretString||'{}');}
export async function POST(request:Request){
 try{
  const session=await inventoryMutationSession();if(session?.role!=='ADMIN')throw Error('FORBIDDEN');
  if(request.headers.get('x-bello-sale-candidates')!=='1'||request.headers.get('origin')!==ORIGIN||request.headers.get('sec-fetch-site')==='cross-site')throw Error('FORBIDDEN');
  const c=await settings();if(!c.clientId||!c.clientSecret)throw Error('NOT_CONFIGURED');
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),nonce=randomBytes(32).toString('base64url');
  await inventoryDdb.send(new PutCommand({TableName:candidateConfig().tableName,Item:{id:'GMAIL_AUTH:'+hash(state),owner:hash(session.owner),nonce:hash(nonce),verifier,used:false,ttl:Math.floor(Date.now()/1000)+600},ConditionExpression:'attribute_not_exists(id)'}));
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:c.clientId,redirect_uri:CALLBACK,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',login_hint:'bello050401@gmail.com',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const r=NextResponse.json({url:url.toString()},{headers:NO_STORE});r.cookies.set('bello-gmail-oauth',nonce,{httpOnly:true,secure:true,sameSite:'lax',path:'/api/sale-candidates/oauth',maxAge:600});return r;
 }catch{return NextResponse.json({error:'Gmail再接続を開始できませんでした。管理者でログインし直してください。'},{status:403,headers:NO_STORE});}
}
export async function GET(request:Request){
 const done=(ok:boolean)=>{const r=NextResponse.redirect(ORIGIN+'/inventory/sale-candidates?gmail='+ (ok?'connected':'failed'));r.cookies.set('bello-gmail-oauth','',{httpOnly:true,secure:true,sameSite:'lax',path:'/api/sale-candidates/oauth',maxAge:0});Object.entries(NO_STORE).forEach(([k,v])=>r.headers.set(k,v));return r;};
 try{
  const session=await inventoryMutationSession();if(session?.role!=='ADMIN')throw Error();
  const p=new URL(request.url).searchParams,state=p.get('state')||'',code=p.get('code')||'',nonce=request.headers.get('cookie')?.match(/(?:^|;\s*)bello-gmail-oauth=([^;]+)/)?.[1]||'';
  if(!/^[\w-]{43}$/.test(state)||!nonce||!code||code.length>4000)throw Error();
  const table=candidateConfig().tableName,key={id:'GMAIL_AUTH:'+hash(state)},r=await inventoryDdb.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true})),v=r.Item;
  if(!v||v.used||v.ttl<=Date.now()/1000||v.owner!==hash(session.owner)||!timingSafeEqual(Buffer.from(v.nonce),Buffer.from(hash(nonce))))throw Error();
  await inventoryDdb.send(new UpdateCommand({TableName:table,Key:key,UpdateExpression:'SET #used=:yes REMOVE verifier',ConditionExpression:'#used=:no',ExpressionAttributeNames:{'#used':'used'},ExpressionAttributeValues:{':yes':true,':no':false}}));
  const c=await settings();const t=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'authorization_code',code,redirect_uri:CALLBACK,code_verifier:v.verifier})});
  if(!t.ok)throw Error();const token=await t.json();if(!token.refresh_token||!token.access_token||token.scope!==SCOPE)throw Error();
  const profile=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token.access_token}});if(!profile.ok||(await profile.json()).emailAddress?.toLowerCase()!=='bello050401@gmail.com')throw Error();
  await sm.send(new PutSecretValueCommand({SecretId:secretId,SecretString:JSON.stringify({...c,configured:true,refreshToken:token.refresh_token})}));
  await inventoryDdb.send(new UpdateCommand({TableName:table,Key:{id:'IMPORT_STATUS'},UpdateExpression:'SET lastAttemptAt=:old REMOVE #e',ExpressionAttributeNames:{'#e':'error'},ExpressionAttributeValues:{':old':'2000-01-01T00:00:00.000Z'}}));
  return done(true);
 }catch{return done(false);}
}

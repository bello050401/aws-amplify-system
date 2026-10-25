import {manageAddressees} from '../../../lib/invoicing/addressees';
import {CognitoJwtVerifier} from 'aws-jwt-verify';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {SecretsManagerClient,GetSecretValueCommand,PutSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {validateInvoice,DEFAULT_CONFIG,UNKNOWN_RESULT,type CalcConfig} from '../../../lib/invoicing/model';
import {seal,unseal} from '../../../lib/invoicing/capability';
import {NewInvoiceProvider} from '../../../lib/invoicing/provider';
import {issueOnce} from '../../../lib/invoicing/issuance';
import {withIssuerLease} from '../../../lib/invoicing/lock';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({}));const secrets=new SecretsManagerClient({});
const TABLE=process.env.OPERATIONS_TABLE!;const SECRET=process.env.MF_SECRET_ARN!;
const verifier=CognitoJwtVerifier.create({userPoolId:process.env.USER_POOL_ID!,clientId:process.env.USER_POOL_CLIENT_ID!,tokenUse:'access'});
type Settings={key:string;clientId?:string;clientSecret?:string;clientAuth?:'basic'|'post';accessToken?:string;refreshToken?:string;expiresAt?:number;settingsVerified?:boolean;config?:CalcConfig};
async function settings():Promise<Settings>{const s=await secrets.send(new GetSecretValueCommand({SecretId:SECRET}));return JSON.parse(s.SecretString||'{}');}
async function storeSettings(s:Settings){await secrets.send(new PutSecretValueCommand({SecretId:SECRET,SecretString:JSON.stringify(s)}));}
async function token(s:Settings,params:Record<string,string>){
 if(!s.clientId||!s.clientSecret)throw new Error('NOT_CONFIGURED');
 const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};const body=new URLSearchParams(params);
 if(s.clientAuth==='post'){body.set('client_id',s.clientId);body.set('client_secret',s.clientSecret);}else headers.Authorization='Basic '+Buffer.from(s.clientId+':'+s.clientSecret).toString('base64');
 const r=await fetch('https://api.biz.moneyforward.com/token',{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('AUTH_FAILED');
 const t=await r.json();if(typeof t.access_token!=='string'||typeof t.refresh_token!=='string')throw new Error('AUTH_FAILED');
 s.accessToken=t.access_token;s.refreshToken=t.refresh_token;s.expiresAt=Date.now()+Number(t.expires_in)*1000;await storeSettings(s);
}
async function access(s:Settings){if(!s.accessToken||!s.refreshToken)throw new Error('NOT_CONNECTED');if(!s.expiresAt||s.expiresAt<Date.now()+60000)await token(s,{grant_type:'refresh_token',refresh_token:s.refreshToken});return s.accessToken!;}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
async function status(operation:string,owner:string){const r=await db.send(new GetCommand({TableName:TABLE,Key:{id:operation},ConsistentRead:true}));if(r.Item?.owner!==hash(owner)||r.Item.ttl<=Date.now()/1000)throw new Error('INVALID_OPERATION');return r.Item.status as string;}
async function transition(operation:string,from:string,to:string){await db.send(new UpdateCommand({TableName:TABLE,Key:{id:operation},UpdateExpression:'SET #s=:to',ConditionExpression:'#s=:from',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':from':from,':to':to}}));}
async function begin(owner:string,kind:string){const operation=randomUUID();await db.send(new PutCommand({TableName:TABLE,Item:{id:operation,owner:hash(owner),status:kind,ttl:Math.floor(Date.now()/1000)+86400},ConditionExpression:'attribute_not_exists(id)'}));return operation;}
const fail=(code:string,message:string)=>({ok:false,code,message});
async function acquireLease(owner:string){try{await db.send(new UpdateCommand({TableName:TABLE,Key:{id:'issuer-lock'},UpdateExpression:'SET #o=:owner, #s=:status, expiresAt=:expires, #ttl=:ttl',ConditionExpression:'attribute_not_exists(expiresAt) OR expiresAt < :now',ExpressionAttributeNames:{'#o':'owner','#s':'status','#ttl':'ttl'},ExpressionAttributeValues:{':owner':owner,':status':'LOCKED',':expires':Date.now()+120000,':ttl':Math.floor(Date.now()/1000)+120,':now':Date.now()}}));return true;}catch(e){if((e as Error).name==='ConditionalCheckFailedException')return false;throw e;}}
async function releaseLease(owner:string){await db.send(new UpdateCommand({TableName:TABLE,Key:{id:'issuer-lock'},UpdateExpression:'SET expiresAt=:zero, #s=:status',ConditionExpression:'#o=:owner',ExpressionAttributeNames:{'#o':'owner','#s':'status'},ExpressionAttributeValues:{':owner':owner,':zero':0,':status':'IDLE'}}));}
// Private IAM invocation only; re-verify the end user's signed token inside this isolated boundary.
// No event/error/provider-body logging. No permissions for inventory, S3, accounting, or existing MF data.
export async function handler(event:{token?:string;action?:string;ticket?:string;input?:unknown;code?:string}){
 let owner:string;
 try{const user=await verifier.verify(event.token||'');if(!user['cognito:groups']?.includes('ADMIN'))return fail('FORBIDDEN','管理者のみ利用できます。');owner=user.sub;}catch{return fail('FORBIDDEN','管理者のログインが必要です。');}
 try{
  if(event.action==='addressees')return await manageAddressees(db,process.env.ADDRESSEES_TABLE!,event.input);
  const leaseOwner=randomUUID();return await withIssuerLease(()=>acquireLease(leaseOwner),()=>releaseLease(leaseOwner),async()=>{
  const s=await settings();if(!s.key||s.key.length<32)throw new Error('NOT_CONFIGURED');
  if(event.action==='status')return {ok:true,connected:!!s.refreshToken,ready:!!s.refreshToken&&s.settingsVerified===true,config:s.config||DEFAULT_CONFIG,canConnect:!!s.clientId&&!!s.clientSecret};
  if(event.action==='oauth-start'){
   if(!s.clientId||!s.clientSecret)return fail('NOT_CONFIGURED','API利用登録の設定が必要です。');
   const operation=await begin(owner,'OAUTH');const v=randomBytes(32).toString('base64url');const state=seal({purpose:'oauth',owner,operation,expires:Date.now()+600000,verifier:v},s.key);
   const url=new URL('https://api.biz.moneyforward.com/authorize');url.search=new URLSearchParams({response_type:'code',client_id:s.clientId,redirect_uri:process.env.OAUTH_CALLBACK!,scope:'mfc/invoice/data.write',state,code_challenge:hash(v),code_challenge_method:'S256'}).toString();
   // PKCE uses base64url SHA256, not its hexadecimal representation.
   url.searchParams.set('code_challenge',createHash('sha256').update(v).digest('base64url'));
   return {ok:true,url:url.toString(),state};
  }
  if(event.action==='oauth-finish'){
   const c=unseal(event.ticket,s.key,owner,'oauth');if(!event.code||event.code.length>4000)throw new Error('INVALID_CODE');await transition(c.operation,'OAUTH','OAUTH_USED');
   await token(s,{grant_type:'authorization_code',code:event.code,redirect_uri:process.env.OAUTH_CALLBACK!,code_verifier:c.verifier!});return {ok:true};
  }
  if(event.action==='prepare'){
   if(!s.refreshToken||!s.settingsVerified)return fail('NOT_READY','マネーフォワードの接続と帳票設定の確認が必要です。');
   const operation=await begin(owner,'READY');return {ok:true,ticket:seal({purpose:'issue',owner,operation,expires:Date.now()+600000},s.key)};
  }
  if(event.action==='issue'){
   if(!s.refreshToken||!s.settingsVerified)return fail('NOT_READY','マネーフォワードの接続と帳票設定の確認が必要です。');
   const input=validateInvoice(event.input);const c=unseal(event.ticket,s.key,owner,'issue');
   // Refresh before crossing the irreversible boundary. The shared lease prevents rotation races.
   const bearer=await access(s);
   const outcome=await issueOnce({transition:(from,to)=>transition(c.operation,from,to)},()=>new NewInvoiceProvider(bearer).create(input,s.config||DEFAULT_CONFIG),async(checkCode)=>{await db.send(new UpdateCommand({TableName:TABLE,Key:{id:c.operation},UpdateExpression:'SET checkCode=:code',ExpressionAttributeValues:{':code':checkCode}}));});
   if(!outcome.ok)return outcome;
   const result=outcome.value;return {ok:true,number:result.number,pdfTicket:seal({purpose:'pdf',owner,operation:c.operation,billingId:result.billingId,expires:Date.now()+600000},s.key),expiresIn:600};
  }
  if(event.action==='pdf'){
   const c=unseal(event.ticket,s.key,owner,'pdf');if(await status(c.operation,owner)!=='SAVED'||!c.billingId)throw new Error('INVALID_OPERATION');
   const data=await new NewInvoiceProvider(await access(s)).downloadNew(c.billingId);return {ok:true,pdf:data.toString('base64')};
  }
  return fail('FORBIDDEN','許可されていない操作です。');
  });
 }catch{return fail('UNAVAILABLE','処理を完了できませんでした。入力内容・接続状態または取得期限を確認してください。');}
}

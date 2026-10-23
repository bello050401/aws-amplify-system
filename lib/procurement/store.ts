import 'server-only';
import {randomUUID,createHash} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,UpdateCommand,DeleteCommand,QueryCommand} from '@aws-sdk/lib-dynamodb';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import outputs from '@/amplify_outputs.json';
import {RestageHttp} from './restageHttp';
import type {RestageLot} from './restage';

type Configuration={region:string;secretArn:string;tableName:string};
function config():Configuration {
  const value=(outputs as unknown as {custom?:{procurement?:Configuration}}).custom?.procurement;
  if(!value?.tableName||!value.secretArn)throw Error('定期仕入れの接続設定を反映中です。しばらくしてからお試しください。');return value;
}
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}),{marshallOptions:{removeUndefinedValues:true}});
export async function getImportRecord(pk:string,sk:string){return(await db.send(new GetCommand({TableName:config().tableName,Key:{pk,sk},ConsistentRead:true}))).Item;}
export async function putImportRecord(item:Record<string,unknown>){await db.send(new PutCommand({TableName:config().tableName,Item:item,ConditionExpression:'attribute_not_exists(pk)'}));}
export async function importRecordsForDate(date:string){
  const rows:Record<string,unknown>[]=[];let key:Record<string,unknown>|undefined;
  do{const page=await db.send(new QueryCommand({TableName:config().tableName,KeyConditionExpression:'pk=:pk',ExpressionAttributeValues:{':pk':'DATE#'+date},ConsistentRead:true,ExclusiveStartKey:key}));rows.push(...page.Items??[]);key=page.LastEvaluatedKey;}while(key);return rows;
}
export async function claimImport(pk:string,sk:string,seconds=180){
  const owner=randomUUID(),now=Date.now();
  try{await db.send(new UpdateCommand({TableName:config().tableName,Key:{pk,sk},UpdateExpression:'SET leaseOwner=:owner, leaseUntil=:until',ConditionExpression:'(attribute_not_exists(leaseUntil) OR leaseUntil<:now) AND (attribute_not_exists(#status) OR #status<>:done)',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':owner':owner,':until':now+seconds*1000,':now':now,':done':'REGISTERED'}}));return owner;}
  catch(e){if(e instanceof Error&&e.name==='ConditionalCheckFailedException')return null;throw e;}
}
export async function releaseImport(pk:string,sk:string,owner:string,fields:Record<string,unknown>={}){
  const entries=Object.entries(fields),names=Object.fromEntries(entries.map(([key],i)=>['#f'+i,key])),values=Object.fromEntries(entries.map(([,v],i)=>[':v'+i,v]));
  await db.send(new UpdateCommand({TableName:config().tableName,Key:{pk,sk},ConditionExpression:'leaseOwner=:owner',UpdateExpression:(entries.length?'SET '+entries.map((_,i)=>`#f${i}=:v${i}`).join(', ')+' ':'')+'REMOVE leaseOwner, leaseUntil',ExpressionAttributeNames:entries.length?names:undefined,ExpressionAttributeValues:{...values,':owner':owner}}));
}
export async function releaseFetchLock(owner:string){try{await db.send(new DeleteCommand({TableName:config().tableName,Key:{pk:'LOCK',sk:'RESTAGE'},ConditionExpression:'leaseOwner=:owner',ExpressionAttributeValues:{':owner':owner}}));}catch(e){if(!(e instanceof Error&&e.name==='ConditionalCheckFailedException'))throw e;}}
export function restageInventoryId(lot:Pick<RestageLot,'date'|'goodsId'>){const hash=createHash('sha256').update('BELLO:RESTAGE:'+lot.date+':'+lot.goodsId).digest('hex');return`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
let cached:{client:RestageHttp;until:number}|undefined;
export async function restageConnection(){
  if(cached&&cached.until>Date.now())return cached.client;
  const c=config(),secret=await new SecretsManagerClient({region:c.region}).send(new GetSecretValueCommand({SecretId:c.secretArn}));
  const credentials=JSON.parse(secret.SecretString??'{}');
  if(typeof credentials.id!=='string'||typeof credentials.password!=='string'||!credentials.id||!credentials.password)throw Error('リステージのログイン情報が未設定です。');
  const client=new RestageHttp(credentials);await client.login();cached={client,until:Date.now()+240000};return client;
}
export function resetRestageConnection(){cached=undefined;}

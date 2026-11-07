import {randomUUID} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,UpdateCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {customObject,planSupplierMerge} from './merge';
import {sha} from './sources';
import {EXTRACTION_VERSION,READABLE_EXTRACTION_VERSIONS,type SourceIdentity,type ExtractionState,type ExtractionResult} from './types';

export interface ExtractionConfig {region:string;table:string;bucket:string;inventoryTable:string;historyTable:string}
export interface ExtractionJob {pk:string;sk:'CURRENT';identity:SourceIdentity;revision:string;state:ExtractionState;createdAt:string;updatedAt:string;requestedBy:string;leaseUntil?:number;resultKey?:string;sources?:{key:string;mime:string;hash:string}[];error?:string;force?:boolean;appliedAt?:string;selectedSourceHashes?:string[]}
export function sourceIdentity(inventory:Record<string,unknown>):SourceIdentity|null{
 const c=customObject(inventory.customFields),r=customObject(c.__restageImport),y=customObject(c.__yahooPurchaseImport),id=String(inventory.id||'');
 if(c.__restageImport&&c.__yahooPurchaseImport)return null;
 if(/^\d{1,12}$/.test(String(r.goodsId))&&/^\d{4}-\d{2}-\d{2}$/.test(String(r.date)))return{provider:'RESTAGE',account:'BELLO-primary',externalId:String(r.goodsId),date:String(r.date),row:'lot',inventoryId:id};
 if(/^[a-zA-Z]\d{8,12}$/.test(String(y.auctionId)))return{provider:'YAHOO',account:'BELLO-primary',externalId:String(y.auctionId),row:'auction',inventoryId:id};
 return null;
}
export function identityKey(i:SourceIdentity){return sha(JSON.stringify([i.provider,i.account,i.externalId,i.date||'',i.row,i.inventoryId]));}
export const extractionKey=(id:string)=>({pk:'EXTRACTION#'+id,sk:'CURRENT'});
export class ExtractionRepository {
 db:DynamoDBDocumentClient;s3:S3Client;
 constructor(readonly config:ExtractionConfig,db?:DynamoDBDocumentClient,s3?:S3Client){this.db=db||DynamoDBDocumentClient.from(new DynamoDBClient({region:config.region}),{marshallOptions:{removeUndefinedValues:true}});this.s3=s3||new S3Client({region:config.region});}
 async inventory(id:string){return(await this.db.send(new GetCommand({TableName:this.config.inventoryTable,Key:{id},ConsistentRead:true}))).Item;}
 async get(id:string){return(await this.db.send(new GetCommand({TableName:this.config.table,Key:extractionKey(id),ConsistentRead:true}))).Item as ExtractionJob|undefined;}
 async request(identity:SourceIdentity,by:string,expectedRevision?:string,force=false,selectedSourceHashes?:string[]){
  if(selectedSourceHashes&&(!selectedSourceHashes.length||selectedSourceHashes.length>3||selectedSourceHashes.some(h=>!/^[a-f0-9]{64}$/.test(h))||new Set(selectedSourceHashes).size!==selectedSourceHashes.length))throw Error('資料の選択を確認してください');
  const now=new Date().toISOString(),job:ExtractionJob={...extractionKey(identity.inventoryId),sk:'CURRENT',identity,revision:randomUUID(),state:'QUEUED',createdAt:now,updatedAt:now,requestedBy:by,force,selectedSourceHashes};
  await this.db.send(new PutCommand({TableName:this.config.table,Item:job,ConditionExpression:expectedRevision?'revision=:old AND (#s<>:processing OR leaseUntil<:now)':'attribute_not_exists(pk)',ExpressionAttributeNames:expectedRevision?{'#s':'state'}:undefined,ExpressionAttributeValues:expectedRevision?{':old':expectedRevision,':processing':'PROCESSING',':now':Date.now()}:undefined}));return job;
 }
 async claim(job:ExtractionJob){
  await this.db.send(new UpdateCommand({TableName:this.config.table,Key:extractionKey(job.identity.inventoryId),ConditionExpression:'revision=:r AND (#s=:queued OR (#s=:processing AND leaseUntil<:now))',UpdateExpression:'SET #s=:processing, leaseUntil=:until, updatedAt=:at',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':r':job.revision,':queued':'QUEUED',':processing':'PROCESSING',':now':Date.now(),':until':Date.now()+360000,':at':new Date().toISOString()}}));
 }
 async cancel(id:string,revision:string){
  await this.db.send(new UpdateCommand({TableName:this.config.table,Key:extractionKey(id),ConditionExpression:'revision=:r AND (#s=:q OR #s=:p)',UpdateExpression:'SET #s=:x, revision=:next, updatedAt=:at, #e=:e REMOVE leaseUntil',ExpressionAttributeNames:{'#s':'state','#e':'error'},ExpressionAttributeValues:{':r':revision,':q':'QUEUED',':p':'PROCESSING',':x':'EXCLUDED',':next':randomUUID(),':at':new Date().toISOString(),':e':'抽出を停止しました。商品情報は変更していません。'}}));
 }
 async finish(job:ExtractionJob,fields:Partial<ExtractionJob>){
  const data={...fields,updatedAt:new Date().toISOString()},entries=Object.entries(data).filter(([,value])=>value!==undefined);
  await this.db.send(new UpdateCommand({TableName:this.config.table,Key:extractionKey(job.identity.inventoryId),ConditionExpression:'revision=:revision AND #state=:processing',UpdateExpression:'SET '+entries.map((_,i)=>`#f${i}=:v${i}`).join(', ')+' REMOVE leaseUntil',ExpressionAttributeNames:{'#state':'state',...Object.fromEntries(entries.map(([k],i)=>['#f'+i,k]))},ExpressionAttributeValues:{':revision':job.revision,':processing':'PROCESSING',...Object.fromEntries(entries.map(([,v],i)=>[':v'+i,v]))}}));
 }
 async object(key:string){
  if(!key.startsWith('procurement-sources/'))throw Error('資料の保存先が不正です');
  const r=await this.s3.send(new GetObjectCommand({Bucket:this.config.bucket,Key:key}));if(!r.Body||Number(r.ContentLength)>26_000_000)throw Error('資料を取得できません');return Buffer.from(await r.Body.transformToByteArray());
 }
 async putObject(key:string,body:Buffer,mime:string){if(!key.startsWith('procurement-sources/')||body.length>26_000_000)throw Error('SOURCE_OBJECT_INVALID');try{await this.s3.send(new PutObjectCommand({Bucket:this.config.bucket,Key:key,Body:body,ContentType:mime,CacheControl:'private, no-store',ServerSideEncryption:'AES256',IfNoneMatch:'*',ChecksumSHA256:Buffer.from(sha(body),'hex').toString('base64')}));}catch(e){if((e as Error).name!=='PreconditionFailed')throw e;}}
 async cached(identity:SourceIdentity,hash:string){return(await this.db.send(new GetCommand({TableName:this.config.table,Key:{pk:'SOURCE#'+identityKey(identity),sk:EXTRACTION_VERSION+'#'+hash},ConsistentRead:true}))).Item?.resultKey as string|undefined;}
 async cache(job:ExtractionJob,hash:string,resultKey:string){await this.db.send(new TransactWriteCommand({TransactItems:[
  {ConditionCheck:{TableName:this.config.table,Key:extractionKey(job.identity.inventoryId),ConditionExpression:'revision=:r AND #s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':r':job.revision,':s':'PROCESSING'}}},
  {Put:{TableName:this.config.table,Item:{pk:'SOURCE#'+identityKey(job.identity),sk:EXTRACTION_VERSION+'#'+hash,resultKey,revision:job.revision}}}
 ]}));}
 async result(job:ExtractionJob){if(!job.resultKey)throw Error('読取結果がまだありません');const r=JSON.parse((await this.object(job.resultKey)).toString()) as ExtractionResult;if(identityKey(r.source.identity)!==identityKey(job.identity)||!READABLE_EXTRACTION_VERSIONS.includes(r.version))throw Error('資料版が一致しません');return r;}
 async apply(job:ExtractionJob,result:ExtractionResult,expectedUpdatedAt:string,by:string){
  if(result.version!==EXTRACTION_VERSION)throw Error('資料の読取方式が更新されています。「抽出のみ再試行」で読み直してください。');
  const row=await this.inventory(job.identity.inventoryId);
  if(!row||row.updatedAt!==expectedUpdatedAt||!sourceIdentity(row)||identityKey(sourceIdentity(row)!)!==identityKey(job.identity))throw Error('商品情報が変更されています。読み直して確認してください。');
  if(!['REVIEW','PARTIAL'].includes(job.state))throw Error('この結果は既に確定済み、または処理中です');
  const plan=planSupplierMerge(row,result,identityKey(job.identity));
  if(!plan.applied.length)throw Error(plan.held.join('\n')||'反映できる項目がありません。原資料を確認してください。');
  const at=new Date().toISOString();
  plan.custom.__belloEditedFields=[...new Set([...(Array.isArray(plan.custom.__belloEditedFields)?plan.custom.__belloEditedFields:[]),...plan.applied])];
  const changes={...plan.patch,customFields:JSON.stringify(plan.custom),updatedAt:at,listUpdatedAt:at,updatedBy:by},entries=Object.entries(changes);
  const hasReview=plan.held.length>0||result.dimensions.some(d=>d.disposition==='REVIEW')||(result.remarks||[]).some(d=>d.disposition==='REVIEW')||result.defects.some(d=>d.disposition==='REVIEW');
  // Stock, job revision and the audit trail commit atomically. A delayed worker
  // or staff edit cannot roll back a newer value, and a retry cannot double apply.
  await this.db.send(new TransactWriteCommand({TransactItems:[
   {Update:{TableName:this.config.inventoryTable,Key:{id:row.id},ConditionExpression:'attribute_exists(id) AND updatedAt=:old AND attribute_not_exists(deletedAt) AND attribute_not_exists(outboundBatchId)',UpdateExpression:'SET '+entries.map((_,i)=>`#f${i}=:v${i}`).join(', '),ExpressionAttributeNames:Object.fromEntries(entries.map(([k],i)=>['#f'+i,k])),ExpressionAttributeValues:{':old':expectedUpdatedAt,...Object.fromEntries(entries.map(([,v],i)=>[':v'+i,v]))}}},
   {Update:{TableName:this.config.table,Key:extractionKey(job.identity.inventoryId),ConditionExpression:'revision=:r AND #s=:old',UpdateExpression:'SET #s=:new, revision=:next, appliedAt=:at, confirmedBy=:by, updatedAt=:at',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':r':job.revision,':next':randomUUID(),':old':job.state,':new':hasReview?'PARTIAL':'APPLIED',':at':at,':by':by}}},
   {Put:{TableName:this.config.table,Item:{pk:job.pk,sk:'CONFIRM#'+job.revision,identity:job.identity,sourceHash:result.source.hash,resultKey:job.resultKey,changes:plan.patch,confirmedAt:at,confirmedBy:by},ConditionExpression:'attribute_not_exists(pk)'}},
   ...Object.entries(plan.patch).map(([field,value])=>({Put:{TableName:this.config.historyTable,Item:{id:randomUUID(),inventoryId:row.id,changedAt:at,changedBy:by,fieldName:'仕入先記載：'+field,oldValue:row[field]==null?null:String(row[field]),newValue:String(value),createdAt:at,updatedAt:at,__typename:'InventoryHistory'},ConditionExpression:'attribute_not_exists(id)'}})),
  ]}));return{held:plan.held,state:hasReview?'PARTIAL':'APPLIED'};
 }
}

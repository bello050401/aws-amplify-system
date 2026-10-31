import {createHash} from 'node:crypto';
import {GetCommand,PutCommand,UpdateCommand,QueryCommand,ScanCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {HeadObjectCommand,GetObjectCommand,PutObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {authorizeOperation,resolveActorContext,type AuthConfig} from './auth';
import type {TrustedClaims} from './ports';
import {err,ok} from './types';
import {validOriginalDeclaration,originalForBatch,originalAvailable,originalUrlTtl,type PhotoOriginal} from './originalRetention';
import {deleteAllPhotoObjectVersions} from '../mediaMaintenance/deletePhotoObject';
import {assetKey,batchKey} from './keys';
import {originalObjectKey} from './originalRetention';
import {readPhotoRows,photoRowKey} from './batchRead';
export interface TemporaryOriginal extends PhotoOriginal {id:string;deviceId:string;sessionId:string;clientAssetId:string;importedAt:string;PK:string;SK:string;assetRef?:{id:string;batchId:string;sequence:number};available?:boolean;removed?:boolean;autoDeleted?:boolean}
const key=(id:string)=>({PK:'ORIGINAL#'+id,SK:'ORIGINAL#'+id});
const objectKey=(id:string)=>'photo-batches/original-imports/'+id+'.bin';
export class TemporaryOriginals{
 constructor(private d:{db:DynamoDBDocumentClient;s3:S3Client;table:string;bucket:string;auth:AuthConfig;now?:()=>number}){}
 async handle(op:'request'|'complete',raw:unknown,claims:TrustedClaims){
  const actor=resolveActorContext(claims,this.d.auth);if(!actor.ok)return actor;
  const allowed=authorizeOperation(actor.value,'requestPhotoAssetUploads');if(!allowed.ok)return allowed;
  const i=raw as {sessionId?:string;clientAssetId?:string;original?:PhotoOriginal;importedAt?:string;id?:string};
  if(!i||!claims.deviceId)return err('INVALID_INPUT','撮影端末を確認できません。');
  const now=this.d.now?.()??Date.now();
  let row:TemporaryOriginal|undefined;
  if(op==='request'){
   if(typeof i.sessionId!=='string'||!i.sessionId||i.sessionId.length>128||typeof i.clientAssetId!=='string'||!i.clientAssetId||i.clientAssetId.length>128||!i.original||!validOriginalDeclaration(i.original))return err('INVALID_INPUT','取込写真の情報が不正です。');
   const imported=Date.parse(i.importedAt??'');
   if(!Number.isFinite(imported)||imported>now+60000)return err('INVALID_INPUT','取込日時が不正です。');
   const id=createHash('sha256').update(JSON.stringify([claims.deviceId,i.sessionId,i.clientAssetId])).digest('hex');
   row=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;
   if(!row){
    row={...key(id),id,deviceId:claims.deviceId,sessionId:i.sessionId,clientAssetId:i.clientAssetId,key:objectKey(id),fileName:i.original.fileName,mimeType:'application/octet-stream',sha256:i.original.sha256,fileSize:i.original.fileSize,importedAt:new Date(imported).toISOString(),requestedAt:new Date(now).toISOString(),expiresAt:'',retentionPolicy:'PRODUCT_LINK'};
    try{await this.d.db.send(new PutCommand({TableName:this.d.table,Item:{...row,entityType:'TemporaryOriginal',GSI1PK:'ORIGINAL_IMPORT',GSI1SK:row.importedAt+'#'+id},ConditionExpression:'attribute_not_exists(PK)'}));}
    catch{return err('CONFLICT','取込写真の保管準備を再実行してください。');}
   }
   if(row.sha256!==i.original.sha256||row.fileSize!==i.original.fileSize)return err('IDEMPOTENCY_CONFLICT','同じ取込番号の原本が異なります。');
  }else{
   if(typeof i.id!=='string'||!/^[a-f0-9]{64}$/.test(i.id))return err('INVALID_INPUT','取込写真を指定してください。');
   row=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(i.id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;
  }
  if(!row||row.deviceId!==claims.deviceId||row.key!==objectKey(row.id))return err('PERMISSION_DENIED','この取込写真にはアクセスできません。');
  if(row.assetRef){
   const saved=await this.resolveStored(row);
   if(saved)return ok({id:row.id,status:'READY',expiresAt:row.expiresAt});
   return err('UPLOAD_NOT_COMPLETE','関連する編集前写真が削除されています。原本はPCに保持しています。');
  }
  if(row.purgedAt)return ok({id:row.id,status:'EXPIRED',expiresAt:row.expiresAt});
  if(op==='request'){
   if(row.uploadedAt)return ok({id:row.id,status:'READY',expiresAt:row.expiresAt});
   const uploadUrl=await getSignedUrl(this.d.s3,new PutObjectCommand({Bucket:this.d.bucket,Key:row.key,ContentType:row.mimeType,ContentLength:row.fileSize,ChecksumSHA256:Buffer.from(row.sha256,'hex').toString('base64')}),{expiresIn:300,unhoistableHeaders:new Set(['x-amz-checksum-sha256'])});
   return ok({id:row.id,status:'UPLOAD',expiresAt:row.expiresAt,upload:{uploadUrl,expectedMimeType:row.mimeType,expectedBytes:row.fileSize,expectedSha256:row.sha256}});
  }
  const h=await this.d.s3.send(new HeadObjectCommand({Bucket:this.d.bucket,Key:row.key,ChecksumMode:'ENABLED'}));
  if(h.ContentLength!==row.fileSize||h.ChecksumSHA256!==Buffer.from(row.sha256,'hex').toString('base64'))return err('UPLOAD_NOT_COMPLETE','取込原本の保存を確認できません。');
  if(!row.uploadedAt){
   const uploadedAt=(h.LastModified??new Date(now)).toISOString(),expiresAt='';
   try{await this.d.db.send(new UpdateCommand({TableName:this.d.table,Key:key(row.id),UpdateExpression:'SET uploadedAt = :at, expiresAt = :expiry',ConditionExpression:'attribute_not_exists(purgedAt) AND attribute_not_exists(uploadedAt)',ExpressionAttributeValues:{':at':uploadedAt,':expiry':expiresAt}}));row={...row,uploadedAt,expiresAt};}
   catch(error){if((error as Error).name!=='ConditionalCheckFailedException')throw error;const latest=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(row.id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;if(!latest?.uploadedAt||latest.purgedAt)return err('UPLOAD_NOT_COMPLETE','取込原本の保存を再確認してください。');row=latest;}
  }
  return ok({id:row.id,status:'READY',expiresAt:row.expiresAt});
 }
 async list(){
  const result=await this.d.db.send(new QueryCommand({TableName:this.d.table,IndexName:'GSI1',KeyConditionExpression:'GSI1PK = :pk',ExpressionAttributeValues:{':pk':'ORIGINAL_IMPORT'},ScanIndexForward:false,Limit:200}));
  const rows=(result.Items??[]) as TemporaryOriginal[],refs=rows.filter(r=>r.assetRef);
  const related=await readPhotoRows(this.d.db,this.d.table,refs.flatMap(r=>[assetKey(r.assetRef!.batchId,r.assetRef!.sequence,r.assetRef!.id),batchKey(r.assetRef!.batchId)]));
  const assets=new Map<string,{id:string;isDeleted?:boolean;purgeStartedAt?:string;original?:PhotoOriginal}>();
  for(const r of refs){const ref=r.assetRef!,a=related.get(photoRowKey(assetKey(ref.batchId,ref.sequence,ref.id)));if(a)assets.set(ref.id,a as {id:string;isDeleted?:boolean;purgeStartedAt?:string;original?:PhotoOriginal});}
  const now=this.d.now?.()??Date.now();
  const batches=new Map<string,{linkedAt?:string}|undefined>();
  for(const batchId of new Set(refs.map(r=>r.assetRef!.batchId)))batches.set(batchId,related.get(photoRowKey(batchKey(batchId))));
  return rows.map(r=>{const a=r.assetRef?assets.get(r.assetRef.id):null;const o=r.assetRef?originalForBatch(a?.original,batches.get(r.assetRef.batchId)?.linkedAt):{...r,expiresAt:'',retentionPolicy:'PRODUCT_LINK' as const};return {...r,expiresAt:o?.expiresAt??'',available:!!o&&originalAvailable(o,now)&&(!r.assetRef||!!a&&!a.isDeleted&&!a.purgeStartedAt),removed:!!r.assetRef&&!!a&&(a.isDeleted||!!a.purgeStartedAt),autoDeleted:!!o?.purgeRecheckedAt};});
 }
 private async resolveStored(r:TemporaryOriginal):Promise<PhotoOriginal|null>{
  const now=this.d.now?.()??Date.now();
  if(!r.uploadedAt)return null;
  if(!r.assetRef)return !r.purgedAt&&r.key===objectKey(r.id)?{...r,expiresAt:'',retentionPolicy:'PRODUCT_LINK'}:null;
  const a=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:assetKey(r.assetRef.batchId,r.assetRef.sequence,r.assetRef.id),ConsistentRead:true}))).Item;
  const batch=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:batchKey(r.assetRef.batchId),ConsistentRead:true}))).Item;
  const o=originalForBatch(a?.original as PhotoOriginal|undefined,batch?.linkedAt);
  return a&&!a.isDeleted&&!a.purgeStartedAt&&o&&originalAvailable(o,now)&&o.sha256===r.sha256&&o.key===originalObjectKey(r.assetRef.batchId,r.assetRef.id)?o:null;
 }
 async stored(id:string){
  if(!/^[a-f0-9]{64}$/.test(id))return null;
  const r=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;
  return r?this.resolveStored(r):null;
 }
 async previewBytes(id:string){
  const r=await this.stored(id);if(!r)return null;
  const result=await this.d.s3.send(new GetObjectCommand({Bucket:this.d.bucket,Key:r.key}));
  if(!result.Body||!result.ContentLength||result.ContentLength>100*1024*1024)return null;
  return {bytes:Buffer.from(await result.Body.transformToByteArray()),fileName:r.fileName};
 }
 async download(id:string){
  const r=await this.stored(id);
  const now=this.d.now?.()??Date.now();
  if(!r)return null;
  return getSignedUrl(this.d.s3,new GetObjectCommand({Bucket:this.d.bucket,Key:r.key,ResponseContentDisposition:"attachment; filename*=UTF-8''"+encodeURIComponent(r.fileName)}),{expiresIn:originalUrlTtl(r,60,now)});
 }
 /** Called only after the associated asset's original bytes have been verified. */
 async metadata(id:string,deviceId:string,sha256:string){
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid archive id');
  const row=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;
  if(!row)return null;
  if(row.deviceId!==deviceId||row.sha256!==sha256)throw Error('Original archive mismatch');
  if(!row.uploadedAt)throw Error('Original archive unavailable');
  return row;
 }
 async retire(id:string,deviceId:string,sha256:string,assetRef?:TemporaryOriginal['assetRef']){
  const row=await this.metadata(id,deviceId,sha256);if(!row)return;
  if(assetRef){await this.d.db.send(new UpdateCommand({TableName:this.d.table,Key:key(id),UpdateExpression:'SET assetRef = :ref',ConditionExpression:'sha256 = :hash',ExpressionAttributeValues:{':ref':assetRef,':hash':sha256}}));row.assetRef=assetRef;}
  await this.purge(row,this.d.now?.()??Date.now());
 }
 private async purge(row:TemporaryOriginal,now:number){
  if(row.key!==objectKey(row.id))throw Error('Invalid archive key');
  await this.d.db.send(new UpdateCommand({TableName:this.d.table,Key:key(row.id),UpdateExpression:'SET purgedAt = if_not_exists(purgedAt, :at)',ConditionExpression:'sha256 = :hash AND expiresAt = :expiry',ExpressionAttributeValues:{':at':new Date(now).toISOString(),':hash':row.sha256,':expiry':row.expiresAt}}));
  await deleteAllPhotoObjectVersions(this.d.s3,this.d.bucket,row.key);
  if(now>=Date.parse(row.purgedAt??row.expiresAt)+16*60000)await this.d.db.send(new UpdateCommand({TableName:this.d.table,Key:key(row.id),UpdateExpression:'SET purgeRecheckedAt = :at',ExpressionAttributeValues:{':at':new Date(now).toISOString()}}));
 }
 async cleanup(now=Date.now(),onlyIds?:ReadonlySet<string>){
  let cursor:Record<string,unknown>|undefined;const result={purged:0,failures:[] as string[]};
  do{
   const p=await this.d.db.send(new ScanCommand({TableName:this.d.table,FilterExpression:'entityType = :type',ExpressionAttributeValues:{':type':'TemporaryOriginal'},ExclusiveStartKey:cursor}));
   for(const row of (p.Items??[]) as TemporaryOriginal[]){
    if(!row.purgedAt)continue;
    if(onlyIds&&!onlyIds.has(row.id)||row.purgeRecheckedAt)continue;
    try{await this.purge(row,now);result.purged++;}catch{result.failures.push(row.id);}
   }cursor=p.LastEvaluatedKey;
  }while(cursor);return result;
 }
}

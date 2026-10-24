import {createHash} from 'node:crypto';
import {GetCommand,PutCommand,UpdateCommand,QueryCommand,ScanCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {HeadObjectCommand,GetObjectCommand,PutObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {authorizeOperation,resolveActorContext,type AuthConfig} from './auth';
import type {TrustedClaims} from './ports';
import {err,ok} from './types';
import {validOriginalDeclaration,ORIGINAL_RETENTION_MS,type PhotoOriginal} from './originalRetention';
import {deleteAllPhotoObjectVersions} from '../mediaMaintenance/deletePhotoObject';
export interface TemporaryOriginal extends PhotoOriginal {id:string;deviceId:string;sessionId:string;clientAssetId:string;importedAt:string;PK:string;SK:string}
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
    row={...key(id),id,deviceId:claims.deviceId,sessionId:i.sessionId,clientAssetId:i.clientAssetId,key:objectKey(id),fileName:i.original.fileName,mimeType:'application/octet-stream',sha256:i.original.sha256,fileSize:i.original.fileSize,importedAt:new Date(imported).toISOString(),requestedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now,imported)+ORIGINAL_RETENTION_MS).toISOString()};
    try{await this.d.db.send(new PutCommand({TableName:this.d.table,Item:{...row,entityType:'TemporaryOriginal',GSI1PK:'ORIGINAL_IMPORT',GSI1SK:row.importedAt+'#'+id},ConditionExpression:'attribute_not_exists(PK)'}));}
    catch{return err('CONFLICT','取込写真の保管準備を再実行してください。');}
   }
   if(row.sha256!==i.original.sha256||row.fileSize!==i.original.fileSize)return err('IDEMPOTENCY_CONFLICT','同じ取込番号の原本が異なります。');
  }else{
   if(typeof i.id!=='string'||!/^[a-f0-9]{64}$/.test(i.id))return err('INVALID_INPUT','取込写真を指定してください。');
   row=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(i.id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;
  }
  if(!row||row.deviceId!==claims.deviceId||row.key!==objectKey(row.id))return err('PERMISSION_DENIED','この取込写真にはアクセスできません。');
  if(row.purgedAt||Date.parse(row.expiresAt)<=now)return ok({id:row.id,status:'EXPIRED',expiresAt:row.expiresAt});
  if(op==='request'){
   if(row.uploadedAt)return ok({id:row.id,status:'READY',expiresAt:row.expiresAt});
   const uploadUrl=await getSignedUrl(this.d.s3,new PutObjectCommand({Bucket:this.d.bucket,Key:row.key,ContentType:row.mimeType,ContentLength:row.fileSize,ChecksumSHA256:Buffer.from(row.sha256,'hex').toString('base64')}),{expiresIn:Math.max(1,Math.min(300,Math.floor((Date.parse(row.expiresAt)-now)/1000))),unhoistableHeaders:new Set(['x-amz-checksum-sha256'])});
   return ok({id:row.id,status:'UPLOAD',expiresAt:row.expiresAt,upload:{uploadUrl,expectedMimeType:row.mimeType,expectedBytes:row.fileSize,expectedSha256:row.sha256}});
  }
  const h=await this.d.s3.send(new HeadObjectCommand({Bucket:this.d.bucket,Key:row.key,ChecksumMode:'ENABLED'}));
  if(h.ContentLength!==row.fileSize||h.ChecksumSHA256!==Buffer.from(row.sha256,'hex').toString('base64'))return err('UPLOAD_NOT_COMPLETE','取込原本の保存を確認できません。');
  await this.d.db.send(new UpdateCommand({TableName:this.d.table,Key:key(row.id),UpdateExpression:'SET uploadedAt = if_not_exists(uploadedAt, :at)',ConditionExpression:'attribute_not_exists(purgedAt)',ExpressionAttributeValues:{':at':new Date(now).toISOString()}}));
  return ok({id:row.id,status:'READY',expiresAt:row.expiresAt});
 }
 async list(){
  const result=await this.d.db.send(new QueryCommand({TableName:this.d.table,IndexName:'GSI1',KeyConditionExpression:'GSI1PK = :pk',ExpressionAttributeValues:{':pk':'ORIGINAL_IMPORT'},ScanIndexForward:false,Limit:200}));
  return (result.Items??[]) as TemporaryOriginal[];
 }
 async download(id:string){
  if(!/^[a-f0-9]{64}$/.test(id))return null;
  const r=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;
  const now=this.d.now?.()??Date.now();
  if(!r?.uploadedAt||r.purgedAt||Date.parse(r.expiresAt)<=now||r.key!==objectKey(id))return null;
  return getSignedUrl(this.d.s3,new GetObjectCommand({Bucket:this.d.bucket,Key:r.key,ResponseContentDisposition:"attachment; filename*=UTF-8''"+encodeURIComponent(r.fileName)}),{expiresIn:Math.max(1,Math.min(60,Math.floor((Date.parse(r.expiresAt)-now)/1000)))});
 }
 /** Called only after the associated asset's original bytes have been verified. */
 async retire(id:string,deviceId:string,sha256:string){
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid archive id');
  const row=(await this.d.db.send(new GetCommand({TableName:this.d.table,Key:key(id),ConsistentRead:true}))).Item as TemporaryOriginal|undefined;
  if(!row)return; // Legacy saves may have no import-stage archive.
  if(row.deviceId!==deviceId||row.sha256!==sha256)throw Error('Original archive mismatch');
  await this.purge(row,this.d.now?.()??Date.now());
 }
 private async purge(row:TemporaryOriginal,now:number){
  if(row.key!==objectKey(row.id))throw Error('Invalid archive key');
  await this.d.db.send(new UpdateCommand({TableName:this.d.table,Key:key(row.id),UpdateExpression:'SET purgedAt = if_not_exists(purgedAt, :at) REMOVE GSI1PK, GSI1SK',ConditionExpression:'sha256 = :hash',ExpressionAttributeValues:{':at':new Date(now).toISOString(),':hash':row.sha256}}));
  await deleteAllPhotoObjectVersions(this.d.s3,this.d.bucket,row.key);
  if(now>=Date.parse(row.purgedAt??row.expiresAt)+16*60000)await this.d.db.send(new UpdateCommand({TableName:this.d.table,Key:key(row.id),UpdateExpression:'SET purgeRecheckedAt = :at',ExpressionAttributeValues:{':at':new Date(now).toISOString()}}));
 }
 async cleanup(now=Date.now(),onlyIds?:ReadonlySet<string>){
  let cursor:Record<string,unknown>|undefined;const result={purged:0,failures:[] as string[]};
  do{
   const p=await this.d.db.send(new ScanCommand({TableName:this.d.table,FilterExpression:'entityType = :type',ExpressionAttributeValues:{':type':'TemporaryOriginal'},ExclusiveStartKey:cursor}));
   for(const row of (p.Items??[]) as TemporaryOriginal[]){
    if(!Number.isFinite(Date.parse(row.expiresAt))){result.failures.push(row.id);continue;}
    if(onlyIds&&!onlyIds.has(row.id)||row.purgeRecheckedAt||!row.purgedAt&&Date.parse(row.expiresAt)>now)continue;
    try{await this.purge(row,now);result.purged++;}catch{result.failures.push(row.id);}
   }cursor=p.LastEvaluatedKey;
  }while(cursor);return result;
 }
}

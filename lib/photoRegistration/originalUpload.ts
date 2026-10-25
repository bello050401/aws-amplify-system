import type {TemporaryOriginals} from "./temporaryOriginals";
import {UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {HeadObjectCommand,PutObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {resolveActorContext,authorizeOperation,assertDeviceOwnsBatch,type AuthConfig} from './auth';
import type {PhotoRegistrationRepository,TrustedClaims} from './ports';
import {err,ok} from './types';
import {assetKey} from './keys';
import {ORIGINAL_RETENTION_MS,originalObjectKey,validOriginalDeclaration,type PhotoOriginal} from './originalRetention';
export class OriginalPhotoUploads{
 constructor(private deps:{db:DynamoDBDocumentClient;s3:S3Client;table:string;bucket:string;repository:PhotoRegistrationRepository;auth:AuthConfig;temporaryOriginals?:TemporaryOriginals;now?:()=>number}){}
 async handle(operation:'request'|'complete',raw:unknown,claims:TrustedClaims){
  const actor=resolveActorContext(claims,this.deps.auth);if(!actor.ok)return actor;
  const auth=authorizeOperation(actor.value,'requestPhotoAssetUploads');if(!auth.ok)return auth;
  const input=raw as {photoAssetId?:string;archiveId?:string;original?:PhotoOriginal & {importedAt?:string|null}};
  if(!input||typeof input.photoAssetId!=='string'||input.photoAssetId.length>180)return err('INVALID_INPUT','画像を指定してください。');
  const found=await this.deps.repository.getAssetWithBatch(input.photoAssetId);
  if(!found)return err('ASSET_NOT_FOUND','画像が見つかりません。');
  const owns=assertDeviceOwnsBatch(claims,actor.value,found.batch.sourceDeviceId);if(!owns.ok)return owns;
  const a=found.asset;
  if(a.isDeleted||a.purgeStartedAt||a.purgedAt||found.batch.status==='ARCHIVED')return err('INVALID_STATUS_TRANSITION','削除済み画像へ元写真を保存できません。');
  if(a.sourceType!=='PHOTO_STATION')return err('INVALID_INPUT','撮影機から取り込んだ画像のみ対象です。');
  const now=this.deps.now?.()??Date.now(),Key=assetKey(a.photoBatchId,a.sequence,a.id);
  const alive='isDeleted = :no AND attribute_not_exists(purgeStartedAt) AND attribute_not_exists(purgedAt)';
  let original=a.original;
  if(operation==='request'){
   if(!input.original||!validOriginalDeclaration(input.original))return err('INVALID_INPUT','編集前写真の形式またはサイズを確認してください（最大100MB）。');
   if(original&&(original.sha256!==input.original.sha256||original.fileSize!==input.original.fileSize))return err('IDEMPOTENCY_CONFLICT','編集前写真が前回と異なります。');
   if(original&&original.key!==originalObjectKey(a.photoBatchId,a.id))return err('INVALID_INPUT','編集前写真の保存先が不正です。');
   if(!original){
    const importedAt=input.original.importedAt==null?now:Date.parse(input.original.importedAt);
    if(!Number.isFinite(importedAt)||importedAt>now+60000)return err('INVALID_INPUT','取込日時が無効です。');
    const archive=input.archiveId&&this.deps.temporaryOriginals&&claims.deviceId?await this.deps.temporaryOriginals.metadata(input.archiveId,claims.deviceId,input.original.sha256):null;
    original={key:originalObjectKey(a.photoBatchId,a.id),fileName:input.original.fileName,mimeType:'application/octet-stream',fileSize:input.original.fileSize,sha256:input.original.sha256,requestedAt:new Date(now).toISOString(),expiresAt:archive?.expiresAt??new Date(now+ORIGINAL_RETENTION_MS).toISOString(),...(archive?.uploadedAt?{retentionStartedAt:archive.uploadedAt}:{})};
    try{await this.deps.db.send(new UpdateCommand({TableName:this.deps.table,Key,UpdateExpression:'SET original = :original',ConditionExpression:alive+' AND attribute_not_exists(original)',ExpressionAttributeValues:{':no':false,':original':original}}));}
    catch{return err('CONFLICT','編集前写真の保存準備が重なりました。再度お試しください。');}
   }
   if(original.purgedAt||Date.parse(original.expiresAt)<=now)return ok({status:'EXPIRED',expiresAt:original.expiresAt});
   if(original.uploadedAt)return ok({status:'READY',expiresAt:original.expiresAt});
   const ttl=Math.min(300,Math.floor((Date.parse(original.expiresAt)-now)/1000));
   if(ttl<1)return ok({status:'EXPIRED',expiresAt:original.expiresAt});
   const uploadUrl=await getSignedUrl(this.deps.s3,new PutObjectCommand({Bucket:this.deps.bucket,Key:original.key,ContentType:original.mimeType,ContentLength:original.fileSize,ChecksumSHA256:Buffer.from(original.sha256,'hex').toString('base64')}),{expiresIn:ttl,unhoistableHeaders:new Set(['x-amz-checksum-sha256'])});
   return ok({status:'UPLOAD',expiresAt:original.expiresAt,upload:{uploadUrl,expectedMimeType:original.mimeType,expectedBytes:original.fileSize,expectedSha256:original.sha256}});
  }
  if(!original||original.key!==originalObjectKey(a.photoBatchId,a.id))return err('INVALID_INPUT','編集前写真の保存準備を先に実行してください。');
  if(original.purgedAt||Date.parse(original.expiresAt)<=now)return err('INVALID_STATUS_TRANSITION','編集前写真の保管期限を過ぎています。');
  const head=await this.deps.s3.send(new HeadObjectCommand({Bucket:this.deps.bucket,Key:original.key,ChecksumMode:'ENABLED'}));
  if(head.ContentLength!==original.fileSize||head.ChecksumSHA256!==Buffer.from(original.sha256,'hex').toString('base64'))return err('UPLOAD_NOT_COMPLETE','編集前写真のアップロードを確認できません。');
  // The first verified upload starts retention; a retry or later edited save must not extend it.
  const retentionStartedAt=original.retentionStartedAt??original.uploadedAt??(head.LastModified??new Date(now)).toISOString();
  const expiresAt=new Date(Date.parse(retentionStartedAt)+ORIGINAL_RETENTION_MS).toISOString();
  try{await this.deps.db.send(new UpdateCommand({TableName:this.deps.table,Key,UpdateExpression:'SET original.uploadedAt = if_not_exists(original.uploadedAt, :at), original.retentionStartedAt = if_not_exists(original.retentionStartedAt, :start), original.expiresAt = :expiry',ConditionExpression:alive+' AND original.sha256 = :hash AND attribute_not_exists(original.purgedAt) AND original.expiresAt = :previous',ExpressionAttributeValues:{':no':false,':at':(head.LastModified??new Date(now)).toISOString(),':start':retentionStartedAt,':expiry':expiresAt,':previous':original.expiresAt,':hash':original.sha256}}));}
  catch{return err('CONFLICT','編集前写真の保存結果を確認できません。');}
  if(input.archiveId&&this.deps.temporaryOriginals&&claims.deviceId)await this.deps.temporaryOriginals.retire(input.archiveId,claims.deviceId,original.sha256,{id:a.id,batchId:a.photoBatchId,sequence:a.sequence});
  return ok({status:'READY',expiresAt});
 }
}

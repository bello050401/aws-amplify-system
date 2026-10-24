import {ScanCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {S3Client} from '@aws-sdk/client-s3';
import {originalObjectKey,type PhotoOriginal} from '../photoRegistration/originalRetention';
import {deleteAllPhotoObjectVersions} from './deletePhotoObject';
export async function cleanupExpiredOriginals(db:DynamoDBDocumentClient,s3:S3Client,table:string,bucket:string,now=Date.now(),onlyBatchId?:string){
 const at=new Date(now).toISOString(),result={purged:0,failures:[] as string[]};let cursor:Record<string,unknown>|undefined;
 do{
  const page=await db.send(new ScanCommand({TableName:table,ConsistentRead:true,ExclusiveStartKey:cursor,FilterExpression:'entityType = :asset AND attribute_exists(original)',ExpressionAttributeValues:{':asset':'PhotoAsset'}}));
  for(const row of page.Items??[]){
   if(onlyBatchId&&row.photoBatchId!==onlyBatchId)continue;
   const o=row.original as PhotoOriginal,expiry=Date.parse(o.expiresAt);
   if(!Number.isFinite(expiry)||expiry>now||o.purgeRecheckedAt)continue;
   if(o.key!==originalObjectKey(row.photoBatchId,row.id)){result.failures.push(row.id);continue;}
   try{
    await db.send(new UpdateCommand({TableName:table,Key:{PK:row.PK,SK:row.SK},UpdateExpression:'SET original.purgedAt = if_not_exists(original.purgedAt, :at)',ConditionExpression:'original.sha256 = :hash AND original.expiresAt = :expiry',ExpressionAttributeValues:{':hash':o.sha256,':expiry':o.expiresAt,':at':at}}));
    await deleteAllPhotoObjectVersions(s3,bucket,o.key);
    if(now>=expiry+16*60*1000)await db.send(new UpdateCommand({TableName:table,Key:{PK:row.PK,SK:row.SK},UpdateExpression:'SET original.purgeRecheckedAt = :at',ConditionExpression:'original.sha256 = :hash AND original.expiresAt = :expiry',ExpressionAttributeValues:{':hash':o.sha256,':expiry':o.expiresAt,':at':at}}));
    result.purged++;
   }catch{result.failures.push(row.id);}
  }
  cursor=page.LastEvaluatedKey;
 }while(cursor);
 return result;
}

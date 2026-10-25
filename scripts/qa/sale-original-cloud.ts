import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,PutCommand,DeleteCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,ListObjectVersionsCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {TemporaryOriginals} from '../../lib/photoRegistration/temporaryOriginals';
import {cleanupExpiredOriginals} from '../../lib/mediaMaintenance/originalPhotoCleanup';
import {deleteAllPhotoObjectVersions} from '../../lib/mediaMaintenance/deletePhotoObject';
import {assetKey,batchKey} from '../../lib/photoRegistration/keys';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'})),s3=new S3Client({region:'us-west-2'}),table='bello-photo-e2e-validation-PhotoTable-1D6BZ5TN1TC7X',bucket='bello-photo-e2e-validation-photobucket-l3bwsehg6e26';
async function main(){
 const body=await fs.readFile(process.argv[2]),sha256=createHash('sha256').update(body).digest('hex'),image=await sharp(body).metadata();assert((image.width??0)>2000);
 const now=Date.now(),batch=randomUUID(),id=randomUUID(),sessionId=randomUUID(),clientAssetId='RAW-01',deviceId='QA-ORIGINAL-'+randomUUID(),claims={userId:'qa-original',groups:['ADMIN'],deviceId};
 const service=new TemporaryOriginals({db,s3,table,bucket,auth:{photoDeviceGroupDeployed:false}}),archive=createHash('sha256').update(JSON.stringify([deviceId,sessionId,clientAssetId])).digest('hex');
 const temp='photo-batches/original-imports/'+archive+'.bin',original='photo-batches/originals/'+batch+'/'+id+'.bin',processed='photo-batches/'+batch+'/processed/'+id+'.jpg';
 const keys=[temp,original,processed],rows=[{PK:'ORIGINAL#'+archive,SK:'ORIGINAL#'+archive},assetKey(batch,1,id),batchKey(batch)];
 const versions=async(Key:string)=>{const r=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:Key}));return [...r.Versions??[],...r.DeleteMarkers??[]].filter(x=>x.Key===Key).length;};
 try{
  const input={sessionId,clientAssetId,importedAt:new Date(now).toISOString(),original:{fileName:'BELLO-qa-original.jpg',fileSize:body.length,sha256}};
  const requested=await service.handle('request',input,claims);assert(requested.ok);const value=requested.value as unknown as {id:string;upload:{uploadUrl:string}};assert.equal(value.id,archive);
  const uploaded=await fetch(value.upload.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream','x-amz-checksum-sha256':Buffer.from(sha256,'hex').toString('base64')},body});assert(uploaded.ok,'S3 original upload');
  assert((await service.handle('complete',{id:archive},claims)).ok);
  const repeated=await service.handle('request',input,claims);assert(repeated.ok);assert.equal((repeated.value as {status:string}).status,'READY');
  const url=await service.download(archive);assert(url);const downloaded=Buffer.from(await(await fetch(url)).arrayBuffer());assert.equal(createHash('sha256').update(downloaded).digest('hex'),sha256);assert.equal(downloaded.length,body.length);
  const meta={key:original,fileName:input.original.fileName,fileSize:body.length,sha256,mimeType:'application/octet-stream',requestedAt:new Date(now-9*86400000).toISOString(),uploadedAt:new Date(now-9*86400000).toISOString(),expiresAt:'',retentionPolicy:'PRODUCT_LINK'};
  for(let n=0;n<2;n++)await s3.send(new PutObjectCommand({Bucket:bucket,Key:original,Body:body}));
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:processed,Body:Buffer.from('QA edited sentinel')}));
  await db.send(new PutCommand({TableName:table,Item:{...rows[2],id:batch,entityType:'PhotoBatch'},ConditionExpression:'attribute_not_exists(PK)'}));
  await db.send(new PutCommand({TableName:table,Item:{...rows[1],id,photoBatchId:batch,sequence:1,entityType:'PhotoAsset',isDeleted:false,original:meta},ConditionExpression:'attribute_not_exists(PK)'}));
  await service.retire(archive,deviceId,sha256,{id,batchId:batch,sequence:1});assert.equal(await versions(temp),0);
  assert.equal((await cleanupExpiredOriginals(db,s3,table,bucket,now,batch)).purged,0);assert.equal(await versions(original),2);
  await db.send(new UpdateCommand({TableName:table,Key:rows[2],UpdateExpression:'SET linkedAt=:at',ExpressionAttributeValues:{':at':new Date(now).toISOString()}}));
  assert.equal((await cleanupExpiredOriginals(db,s3,table,bucket,now+7*86400000-1,batch)).purged,0);
  const expired=await cleanupExpiredOriginals(db,s3,table,bucket,now+7*86400000+1,batch);assert.equal(expired.purged,1);assert.deepEqual(expired.failures,[]);assert.equal(await versions(original),0);
  await s3.send(new HeadObjectCommand({Bucket:bucket,Key:processed}));
  await cleanupExpiredOriginals(db,s3,table,bucket,now+7*86400000+17*60000,batch);
  assert.equal((await cleanupExpiredOriginals(db,s3,table,bucket,now+7*86400000+18*60000,batch)).purged,0);
  const result={at:new Date().toISOString(),fileBytes:body.length,width:image.width,height:image.height,sha256,downloadByteIdentical:true,duplicateUploadPrevented:true,unlinkedPreserved:true,linkedSevenDaysPreserved:true,expiredAllVersionsDeleted:true,editedPreserved:true,retryIdempotent:true,clockAdvancedOnDisposableFixture:true};
  await fs.writeFile('artifacts/sale-workflow-20261025/original-cloud-test.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{for(const Key of keys)await deleteAllPhotoObjectVersions(s3,bucket,Key);for(const Key of rows)await db.send(new DeleteCommand({TableName:table,Key}));}
}
main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

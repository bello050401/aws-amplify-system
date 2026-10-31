import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fromIni} from '@aws-sdk/credential-providers';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand,waitUntilTableExists,waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,UpdateCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,GetObjectCommand,ListObjectVersionsCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {TemporaryOriginals} from '../../lib/photoRegistration/temporaryOriginals';
import {OriginalPhotoUploads} from '../../lib/photoRegistration/originalUpload';
import {originalObjectKey,ORIGINAL_RETENTION_MS} from '../../lib/photoRegistration/originalRetention';
import {cleanupExpiredOriginals} from '../../lib/mediaMaintenance/originalPhotoCleanup';
import {deleteAllPhotoObjectVersions} from '../../lib/mediaMaintenance/deletePhotoObject';
import {assetKey,batchKey} from '../../lib/photoRegistration/keys';
import type {PhotoRegistrationRepository} from '../../lib/photoRegistration/ports';

async function main(){
 assert.equal(process.env.BELLO_AUDIT_SCRATCH,'1');
 const cfg={region:'us-west-2',credentials:fromIni({profile:'Bello'}),maxAttempts:5};
 const raw=new DynamoDBClient(cfg),db=DynamoDBDocumentClient.from(raw,{marshallOptions:{removeUndefinedValues:true}}),s3=new S3Client(cfg);
 const table='Bello-QA-Original-'+randomUUID().slice(0,8),bucket='bello-photo-e2e-validation-photobucket-l3bwsehg6e26',batchId=randomUUID(),assetId=batchId+'#A#'+randomUUID(),keys=new Set<string>();
 let now=Date.now(),created=false;const start=now,report={passed:[] as string[],cleanup:''};
 const check=(label:string)=>{report.passed.push(label);console.log('PASS',label);};
 const bytes=readFileSync('artifacts/system-audit-20261101/audit-photo-1.png'),hash=createHash('sha256').update(bytes).digest('hex');
 const claims={userId:'audit-device',deviceId:'audit-device',groups:['PHOTO_DEVICE']},deps={db,s3,table,bucket,auth:{photoDeviceGroupDeployed:true},now:()=>now};
 const temp=new TemporaryOriginals(deps),read=async(Key:{PK:string;SK:string})=>(await db.send(new GetCommand({TableName:table,Key,ConsistentRead:true}))).Item!;
 const versions=async(key:string)=>{const r=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:key}));return [...(r.Versions??[]),...(r.DeleteMarkers??[])].filter(x=>x.Key===key);};
 const put=async(key:string,body=bytes)=>{keys.add(key);await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentType:'application/octet-stream',ChecksumSHA256:createHash('sha256').update(body).digest('base64')}));};
 const repository={getAssetWithBatch:async()=>({asset:await read(assetKey(batchId,0,assetId)),batch:await read(batchKey(batchId))})} as unknown as PhotoRegistrationRepository;
 const uploader=new OriginalPhotoUploads({...deps,repository,temporaryOriginals:temp});
 const input={sessionId:randomUUID(),clientAssetId:'one',importedAt:new Date(start).toISOString(),original:{fileName:'original.png',fileSize:bytes.length,sha256:hash}};
 const must=(r:any)=>{assert.equal(r.ok,true,JSON.stringify(r.ok?{ok:true}:r));return r.value;};
 try{
  await raw.send(new CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'PK',KeyType:'HASH'},{AttributeName:'SK',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'PK',AttributeType:'S'},{AttributeName:'SK',AttributeType:'S'},{AttributeName:'GSI1PK',AttributeType:'S'},{AttributeName:'GSI1SK',AttributeType:'S'}],GlobalSecondaryIndexes:[{IndexName:'GSI1',KeySchema:[{AttributeName:'GSI1PK',KeyType:'HASH'},{AttributeName:'GSI1SK',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}],Tags:[{Key:'Purpose',Value:'disposable-audit'}]}));created=true;
  await waitUntilTableExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName:table});
  const requested=must(await temp.handle('request',input,claims)),id=requested.id,key='photo-batches/original-imports/'+id+'.bin';
  assert.equal(requested.status,'UPLOAD');keys.add(key);
  await assert.rejects(temp.handle('complete',{id},claims));assert.equal((await read({PK:'ORIGINAL#'+id,SK:'ORIGINAL#'+id})).uploadedAt,undefined);check('missing upload cannot become READY');
  await put(key);must(await temp.handle('complete',{id},claims));
  assert.deepEqual((await temp.previewBytes(id))!.bytes,bytes);assert.equal(must(await temp.handle('request',input,claims)).status,'READY');
  assert.equal((await temp.handle('request',{...input,original:{...input.original,sha256:'b'.repeat(64)}},claims)).ok,false);
  assert.equal((await temp.handle('complete',{id},{...claims,deviceId:'other-device'})).ok,false);check('original byte-for-byte checksum, repeat deduplication and device ownership');
  await db.send(new PutCommand({TableName:table,Item:{...batchKey(batchId),id:batchId,entityType:'PhotoBatch',sourceDeviceId:claims.deviceId,status:'READY'}}));
  await db.send(new PutCommand({TableName:table,Item:{...assetKey(batchId,0,assetId),id:assetId,entityType:'PhotoAsset',photoBatchId:batchId,sequence:0,isDeleted:false,sourceType:'PHOTO_STATION'}}));
  must(await uploader.handle('request',{photoAssetId:assetId,archiveId:id,original:input.original},claims));
  const original=originalObjectKey(batchId,assetId),edited='photo-batches/'+batchId+'/processed/audit.png';
  await put(original);await put(original);await put(edited,Buffer.from('processed file must survive'));
  must(await uploader.handle('complete',{photoAssetId:assetId,archiveId:id},claims));assert.equal((await versions(key)).length,0);assert.deepEqual((await temp.previewBytes(id))!.bytes,bytes);check('verified original associated with edited photo; temporary duplicate removed');
  assert.equal((await cleanupExpiredOriginals(db,s3,table,bucket,start+10*86400000)).purged,0);assert((await versions(original)).length>=2);check('unlinked originals retained even after seven days');
  const linkedAt=new Date(start+86400000).toISOString();await db.send(new UpdateCommand({TableName:table,Key:batchKey(batchId),UpdateExpression:'SET linkedAt=:t',ExpressionAttributeValues:{':t':linkedAt}}));
  const expiry=Date.parse(linkedAt)+ORIGINAL_RETENTION_MS;
  now=expiry-1;assert(await temp.stored(id));assert.equal((await cleanupExpiredOriginals(db,s3,table,bucket,now)).purged,0);
  now=expiry;assert.equal(await temp.stored(id),null);assert.equal((await uploader.handle('complete',{photoAssetId:assetId},claims)).ok,false);check('retention starts at product link; unavailable exactly at seven days');
  let fail=true;const failing={send:async(command:any)=>{if(command instanceof DeleteObjectCommand&&fail){fail=false;throw Error('injected temporary S3 failure');}return s3.send(command);}} as unknown as S3Client;
  const failed=await cleanupExpiredOriginals(db,failing,table,bucket,now);assert.equal(failed.failures.length,1);assert((await versions(original)).length>=2);
  const retry=await cleanupExpiredOriginals(db,s3,table,bucket,now+17*60000);assert.deepEqual(retry.failures,[]);assert.equal((await versions(original)).length,0);assert((await read(assetKey(batchId,0,assetId))).original.purgeRecheckedAt);assert.equal(await(await s3.send(new GetObjectCommand({Bucket:bucket,Key:edited}))).Body!.transformToString(),'processed file must survive');check('failed purge retries; every original version removed; edited image preserved');
  const listing=await temp.list();assert.equal(listing.length,1);assert.equal(listing[0].available,false);assert.equal(listing[0].autoDeleted,true);check('original list reports automatic deletion after verified purge');
 }finally{
  for(const key of keys){await deleteAllPhotoObjectVersions(s3,bucket,key);assert.equal((await versions(key)).length,0);}
  if(created){await raw.send(new DeleteTableCommand({TableName:table}));await waitUntilTableNotExists({client:raw,maxWaitTime:90,minDelay:1,maxDelay:3},{TableName:table});}
  report.cleanup='Scratch table and every fixture object version confirmed absent';writeFileSync('artifacts/system-audit-20261101/original-storage-aws.json',JSON.stringify(report,null,2));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

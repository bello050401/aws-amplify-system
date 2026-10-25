import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GetCommand,PutCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {S3Client,HeadObjectCommand} from '@aws-sdk/client-s3';
import {TemporaryOriginals} from '../lib/photoRegistration/temporaryOriginals';
import {OriginalPhotoUploads} from '../lib/photoRegistration/originalUpload';
import {ORIGINAL_RETENTION_MS} from '../lib/photoRegistration/originalRetention';
test('7日間はクラウド初回アップロードから。再試行・編集後への関連付けで延長しない',async()=>{
 let now=Date.parse('2026-10-25T01:00:00Z');const first=now;let row:any,asset:any;
 const hash='a'.repeat(64);const s3=new S3Client({region:'us-west-2',credentials:{accessKeyId:'test',secretAccessKey:'test'}});s3.send=(async(c:any)=>{if(c instanceof HeadObjectCommand)return {ContentLength:12,ChecksumSHA256:Buffer.from(hash,'hex').toString('base64'),LastModified:new Date(first)};return {Versions:[],DeleteMarkers:[]};}) as any;
 const db={send:async(c:any)=>{const i=c.input;if(c instanceof GetCommand)return {Item:i.Key.PK.startsWith('ORIGINAL#')?row:asset};if(c instanceof PutCommand){row=structuredClone(i.Item);return {};}
 assert.ok(c instanceof UpdateCommand);const v=i.ExpressionAttributeValues;if(i.Key.PK.startsWith('ORIGINAL#')){if(v[':ref'])row.assetRef=v[':ref'];else if(v[':expiry']&&v[':at']&&!v[':hash']){row.uploadedAt=v[':at'];row.expiresAt=v[':expiry'];}else if(i.UpdateExpression.includes('purgedAt'))row.purgedAt??=v[':at'];else row.purgeRecheckedAt=v[':at'];}
 else if(v[':original'])asset.original=structuredClone(v[':original']);else {asset.original.uploadedAt??=v[':at'];asset.original.retentionStartedAt??=v[':start'];asset.original.expiresAt=v[':expiry'];}return {};}} as unknown as DynamoDBDocumentClient;
 const claims={userId:'device',groups:['PHOTO_DEVICE'],deviceId:'device'};const deps={db,s3,table:'t',bucket:'qa-test-only',auth:{photoDeviceGroupDeployed:true},now:()=>now};const temp=new TemporaryOriginals(deps);
 const input={sessionId:'s',clientAssetId:'a',importedAt:'2026-10-01T00:00:00Z',original:{fileName:'a.jpg',fileSize:12,sha256:hash}};
 const requested=await temp.handle('request',input,claims);assert.ok(requested.ok);if(!requested.ok)return;assert.equal(requested.value.status,'UPLOAD');const id=requested.value.id;
 assert.equal((await temp.handle('complete',{id},claims)).ok,true);assert.equal(Date.parse(row.expiresAt)-first,ORIGINAL_RETENTION_MS);
 now+=86400000;const again=await temp.handle('request',input,claims);assert.ok(again.ok);if(again.ok)assert.equal(again.value.status,'READY');assert.equal(Date.parse(row.expiresAt)-first,ORIGINAL_RETENTION_MS);
 asset={id:'asset',photoBatchId:'batch',sequence:0,isDeleted:false,sourceType:'PHOTO_STATION'};const uploader=new OriginalPhotoUploads({...deps,temporaryOriginals:temp,repository:{getAssetWithBatch:async()=>({asset,batch:{sourceDeviceId:'device'}})} as any});
 assert.equal((await uploader.handle('request',{photoAssetId:'asset',archiveId:id,original:input.original},claims)).ok,true);
 assert.equal((await uploader.handle('complete',{photoAssetId:'asset',archiveId:id},claims)).ok,true);assert.equal(Date.parse(asset.original.expiresAt)-first,ORIGINAL_RETENTION_MS);assert.ok(row.purgedAt);assert.equal(row.assetRef.id,'asset');
 assert.ok(await temp.stored(id));const retry=await temp.handle('request',input,claims);assert.ok(retry.ok);if(retry.ok)assert.equal(retry.value.status,'READY');
 asset.isDeleted=true;assert.equal(await temp.stored(id),null);assert.equal((await temp.handle('request',input,claims)).ok,false);
 now=first+ORIGINAL_RETENTION_MS+1;assert.equal(await temp.stored(id),null);
});

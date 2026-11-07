const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const {S3Client,CreateBucketCommand,PutBucketVersioningCommand,PutPublicAccessBlockCommand,PutObjectCommand,DeleteObjectCommand,ListObjectVersionsCommand,DeleteBucketCommand}=require('@aws-sdk/client-s3');
const bucket='bello-qa-inquiry-'+Date.now(),key='messaging/attachments/qa/one.jpg',other=key+'.other',s3=new S3Client({region:'us-west-2'});
process.env.MESSAGING_ATTACHMENT_BUCKET=bucket;
const original=Module._load;Module._load=function(request){if(request==='server-only')return {};return original.apply(this,arguments);};require('tsx/cjs');
(async()=>{let created=false;try{
 await s3.send(new CreateBucketCommand({Bucket:bucket,CreateBucketConfiguration:{LocationConstraint:'us-west-2'}}));created=true;
 await s3.send(new PutPublicAccessBlockCommand({Bucket:bucket,PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}}));
 await s3.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}));
 for(let i=0;i<3;i++)await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:'synthetic-'+i}));
 await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));
 await s3.send(new PutObjectCommand({Bucket:bucket,Key:other,Body:'preserve'}));
 const {purgeIncomingAttachment}=require('../../lib/messaging/attachmentStore.ts');await purgeIncomingAttachment(key);await purgeIncomingAttachment(key);
 const check=await s3.send(new ListObjectVersionsCommand({Bucket:bucket}));assert.equal((check.Versions??[]).filter(v=>v.Key===key).length,0);assert.equal((check.DeleteMarkers??[]).length,0);assert.equal(check.Versions.length,1);assert.equal(check.Versions[0].Key,other);
 await assert.rejects(purgeIncomingAttachment('inventory/other.jpg'));
 console.log('PASS 実S3の3世代と削除マーカーを消去、隣接画像を維持、再削除と範囲制限を確認');
 fs.writeFileSync('artifacts/whole-instruction-20261107/inquiry-attachment-tests.json',JSON.stringify({at:new Date().toISOString(),bucket,versionsDeleted:3,markersDeleted:1,unrelatedPreserved:true,idempotent:true,outsidePrefixRejected:true}));
 }finally{if(created){assert(bucket.startsWith('bello-qa-inquiry-'));const remaining=await s3.send(new ListObjectVersionsCommand({Bucket:bucket}));for(const v of [...remaining.Versions??[],...remaining.DeleteMarkers??[]])await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:v.Key,VersionId:v.VersionId}));await s3.send(new DeleteBucketCommand({Bucket:bucket}));console.log('QA bucket deleted');}}})().catch(e=>{console.error(e.name,e.message);process.exitCode=1;});

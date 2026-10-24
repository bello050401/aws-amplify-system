import {DeleteObjectCommand,ListObjectVersionsCommand,type S3Client} from '@aws-sdk/client-s3';
export async function deleteAllPhotoObjectVersions(s3:S3Client,bucket:string,key:string){
 if(!key.startsWith('photo-batches/')||key.includes('..'))throw Error('Invalid photo key');
 let keyMarker:string|undefined,versionMarker:string|undefined;
 do{
  const page=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:key,KeyMarker:keyMarker,VersionIdMarker:versionMarker}));
  for(const object of [...page.Versions??[],...page.DeleteMarkers??[]])if(object.Key===key)await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key,VersionId:object.VersionId}));
  keyMarker=page.IsTruncated?page.NextKeyMarker:undefined;versionMarker=page.IsTruncated?page.NextVersionIdMarker:undefined;
 }while(keyMarker);
 const remaining=await s3.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:key,MaxKeys:1}));
 if([...remaining.Versions??[],...remaining.DeleteMarkers??[]].some(o=>o.Key===key))throw Error('Photo versions remain');
}

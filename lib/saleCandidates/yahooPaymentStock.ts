import {randomUUID} from 'node:crypto';
import {ScanCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {CopyObjectCommand,DeleteObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {DynamoPhotoRegistrationRepository} from '../photoRegistration/awsRepository';
import {photoAssetS3Key} from '../photoRegistration/types';
import {buildDuplicateImages,isPhotoProcessedCopyKey} from '../inventory/duplicateImages';
import type {SoldOutPorts} from '../inventory/soldOutCore';

/** The payment worker has no mail, EC or browser credentials. Only copies of the
 * verified stock's current pictures are created; no original object is deleted. */
export function createYahooPaymentStockPorts(config:{db:DynamoDBDocumentClient;table:(name:string)=>string;s3:S3Client;inventoryBucket:string;photoTable:string;photoBucket:string;nextSku:()=>Promise<string>}):Pick<SoldOutPorts,'categories'|'nextSku'|'copyPhotos'|'discardPhotos'> {
 const {db,table,s3,inventoryBucket,photoTable,photoBucket}=config;
 const repository=new DynamoPhotoRegistrationRepository({ddb:db,tableName:photoTable,inventoryTableName:table('Inventory'),now:()=>new Date()});
 const prefix='inventory/yahoo-payment/';
 const discardPhotos=async(images:unknown[])=>{
  const keys=new Set(images.flatMap(raw=>{const p=raw as Record<string,unknown>;return [p.storageKey,p.thumbnailKey,p.mediumKey].filter((v):v is string=>typeof v==='string'&&v.startsWith(prefix));}));
  await Promise.all([...keys].map(Key=>s3.send(new DeleteObjectCommand({Bucket:inventoryBucket,Key}))));
 };
 return {
  nextSku:config.nextSku,discardPhotos,
  categories:async()=>{const all:{id:string;name:string}[]=[];let cursor:Record<string,any>|undefined;do{const page=await db.send(new ScanCommand({TableName:table('Category'),ProjectionExpression:'id,#n',ExpressionAttributeNames:{'#n':'name'},ExclusiveStartKey:cursor,ConsistentRead:true}));all.push(...(page.Items??[]) as {id:string;name:string}[]);cursor=page.LastEvaluatedKey;}while(cursor);return all;},
  copyPhotos:async source=>{
   const parsed=typeof source.images==='string'?JSON.parse(source.images):source.images;
   if(parsed!=null&&!Array.isArray(parsed))throw Error('PAYMENT_IMAGE_INVALID');
   const assets=[];let cursor:string|null=null,batchCount=0;
   do{const page=await repository.listBatchesForInventory(String(source.id),100,cursor);for(const indexed of page.items){const batch=await repository.getBatchById(indexed.id);if(batch&&batch.inventoryId===source.id)assets.push(...await repository.getAssetsForBatch(batch.id));}cursor=page.nextCursor;batchCount+=page.items.length;if(batchCount>=300&&cursor)throw Error('PAYMENT_IMAGE_LIMIT');}while(cursor);
   const selected=buildDuplicateImages(parsed??[],assets.map(a=>({...a,thumbnailUrl:null,processedUrl:null})),photoBucket);
   const thumbnailKeys=new Map(assets.filter(a=>!a.isDeleted&&!a.purgedAt&&a.status==='READY').map(a=>[a.id,photoAssetS3Key(a.photoBatchId,a.id,'THUMBNAIL','jpg')]));
   const originals=[...selected.normal,...selected.damage].map(photo=>({...photo,thumbnailKey:photo.sourceBucket===photoBucket?thumbnailKeys.get(photo.storageKey.split('/').at(-1)!.replace(/\.[^.]+$/,''))??photo.thumbnailKey:photo.thumbnailKey})),copied=new Map<string,string>(),created:unknown[]=[];
   const allowed=(key:string,bucket:string)=>bucket===inventoryBucket&&key.startsWith('inventory/')||bucket===photoBucket&&isPhotoProcessedCopyKey(key.replace('/thumbnail/','/processed/'));
   for(const photo of originals)for(const key of [photo.storageKey,photo.thumbnailKey,photo.mediumKey].filter(Boolean))if(!allowed(key!,photo.sourceBucket??inventoryBucket))throw Error('PAYMENT_IMAGE_SOURCE_INVALID');
   const copy=async(key:string,bucket:string)=>{
    if(!allowed(key,bucket))throw Error('PAYMENT_IMAGE_SOURCE_INVALID');
    const identity=bucket+':'+key;if(copied.has(identity))return copied.get(identity)!;
    const ext=key.match(/\.[a-z0-9]{1,8}$/i)?.[0]?.toLowerCase()??'';
    const target=prefix+randomUUID()+ext;
    await s3.send(new CopyObjectCommand({Bucket:inventoryBucket,Key:target,CopySource:bucket+'/'+key.split('/').map(encodeURIComponent).join('/')}));
    copied.set(identity,target);created.push({storageKey:target});return target;
   };
   try{const result=[];for(const photo of originals){const bucket=photo.sourceBucket??inventoryBucket,storageKey=await copy(photo.storageKey,bucket);const {sourceBucket:_,...rest}=photo;result.push({...rest,storageKey,thumbnailKey:photo.thumbnailKey?await copy(photo.thumbnailKey,bucket):storageKey,mediumKey:photo.mediumKey?await copy(photo.mediumKey,bucket):storageKey,sourceSystem:null,sourceUrl:null});}return result;}
   catch(error){await discardPhotos(created);throw error;}
  }
 };
}

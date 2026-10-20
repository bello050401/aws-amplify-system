import 'server-only';
import {createHash} from 'node:crypto';
import {S3Client,CopyObjectCommand,HeadObjectCommand,ListObjectsV2Command,DeleteObjectsCommand} from '@aws-sdk/client-s3';
import outputs from '@/amplify_outputs.json';
import {getPhotoRegistrationWebAdapter,getWebTrustedClaims} from '@/lib/photoRegistration/webAdapter';
import {extensionForMimeType,photoAssetS3Key} from '@/lib/photoRegistration/types';
import {serverDataClient} from '@/lib/amplify/dataClient';
import type {OutboundRow} from './types';
import {parseJsonField} from './types';
const s3=new S3Client({region:process.env.AWS_REGION||'us-west-2'});
const bucket=outputs.storage.bucket_name;
export async function nextSplitSku(){const result=await serverDataClient.mutations.generateInventorySku({authMode:'userPool'});if(!result.data||result.errors?.length)throw Error('移動分の管理番号を作成できませんでした。');return result.data;}
export async function prepareSplitPhotos(source:Record<string,unknown>,item:OutboundRow){
 const images=parseJsonField<Record<string,unknown>[]>(source.images,[]).map(photo=>({...photo}));
 const adapter=getPhotoRegistrationWebAdapter();
 if(adapter){const claims=await getWebTrustedClaims();if(!claims)throw Error('写真の確認のため再ログインしてください。');const result=await adapter.listInventoryPhotoAssets(String(source.id),claims);if(!result.ok)throw Error('商品の写真を読み込めませんでした。');if(result.value.truncated)throw Error('写真が多いため一度に分割できません。');
  for(const photo of result.value.assets.filter(p=>p.status==='READY'&&!p.isDeleted))images.push({storageKey:photoAssetS3Key(photo.photoBatchId,photo.id,'PROCESSED',extensionForMimeType(photo.declared.PROCESSED.mimeType)),sourceBucket:process.env.PHOTO_REGISTRATION_BUCKET_NAME,type:photo.inventoryImageType==='DAMAGE'?'DAMAGE':'NORMAL',sortOrder:images.length,isPrimary:!images.some(i=>i.type!=='DAMAGE'),originalHash:photo.declared.PROCESSED.sha256});
 }
 const copy=async(key:string,sourceBucket=bucket)=>{
  const extension=/\.(jpg|jpeg|png|webp|gif|avif|heic)$/i.exec(key)?.[0]??'.jpg';
  const target=`inventory/outbound/${item.batchId}/${item.splitInventoryId}/${createHash('sha256').update(sourceBucket+'/'+key).digest('hex')}${extension}`;
  try{await s3.send(new HeadObjectCommand({Bucket:bucket,Key:target}));return target;}catch(e){if((e as {name?:string}).name!=='NotFound')throw e;}
  await s3.send(new CopyObjectCommand({Bucket:bucket,Key:target,CopySource:sourceBucket+'/'+key.split('/').map(encodeURIComponent).join('/')}));return target;
 };
 const copied=[];
 for(const photo of images){if(typeof photo.storageKey!=='string')throw Error('商品の画像情報を確認してください。');const storageKey=await copy(photo.storageKey,typeof photo.sourceBucket==='string'?photo.sourceBucket:bucket);const thumbnailKey=typeof photo.thumbnailKey==='string'?await copy(photo.thumbnailKey):storageKey;const mediumKey=typeof photo.mediumKey==='string'?await copy(photo.mediumKey):storageKey;const rest={...photo};delete rest.sourceBucket;copied.push({...rest,storageKey,thumbnailKey,mediumKey,sourceSystem:null,sourceUrl:null});}
 return copied;
}
export async function removeUnsentSplitPhotos(batchId:string){
 let token:string|undefined;
 do{const result=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:`inventory/outbound/${batchId}/`,ContinuationToken:token}));if(result.Contents?.length){const removed=await s3.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:result.Contents.map(item=>({Key:item.Key!})),Quiet:true}}));if(removed.Errors?.length)throw Error('分割用写真の取消を完了できませんでした。もう一度取り消してください。');}token=result.NextContinuationToken;}while(token);
}

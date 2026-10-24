import 'server-only';
import {randomUUID} from 'node:crypto';
import {CopyObjectCommand, S3Client} from '@aws-sdk/client-s3';
import outputs from '@/amplify_outputs.json';
import {getPhotoRegistrationWebAdapter,getWebTrustedClaims} from '@/lib/photoRegistration/webAdapter';
import {photoAssetS3Key,extensionForMimeType} from '@/lib/photoRegistration/types';
import {removeInventoryImage} from './imageServerOps';

const bucket=outputs.storage.bucket_name;
const s3=new S3Client({region:process.env.AWS_REGION||'us-west-2'});
export async function discardSoldOutPhotos(images:unknown[]) {
  const keys=new Set(images.flatMap(raw=>{const p=raw as Record<string,unknown>;return [p.storageKey,p.thumbnailKey,p.mediumKey].filter((key):key is string=>typeof key==='string');}));
  await Promise.all([...keys].map(removeInventoryImage));
}
export async function copySoldOutPhotos(source:Record<string,unknown>):Promise<unknown[]> {
  const parsed=typeof source.images==='string'?JSON.parse(source.images):source.images;
  if(parsed!=null&&!Array.isArray(parsed))throw Error('画像情報を確認できませんでした。');
  const originals:Record<string,unknown>[]=(parsed??[]).map((image:Record<string,unknown>)=>({...image}));
  const adapter=getPhotoRegistrationWebAdapter();
  if(!adapter) throw Error('写真サービスに接続できません。商品は変更していません。');
  const claims=await getWebTrustedClaims();
  if(!claims)throw Error('再ログインしてください。');
  const assets=await adapter.listInventoryPhotoAssets(String(source.id),claims);
  if(!assets.ok||assets.value.truncated)throw Error('商品画像を確認できません。商品は変更していません。');
  for(const photo of assets.value.assets.filter(photo=>photo.status==='READY'&&!photo.isDeleted)) originals.push({storageKey:photoAssetS3Key(photo.photoBatchId,photo.id,'PROCESSED',extensionForMimeType(photo.declared.PROCESSED.mimeType)),sourceBucket:process.env.PHOTO_REGISTRATION_BUCKET_NAME,type:photo.inventoryImageType==='DAMAGE'?'DAMAGE':'NORMAL',sortOrder:originals.length,isPrimary:!originals.some(photo=>photo.type!=='DAMAGE'),originalHash:photo.declared.PROCESSED.sha256});
  const created:string[]=[];
  const copy=async(key:string,fromBucket=bucket)=>{
    if(!key || (fromBucket!==bucket && fromBucket!==process.env.PHOTO_REGISTRATION_BUCKET_NAME))throw Error('画像の保存先を確認できません。');
    const target=`inventory/${randomUUID()}${/\.[a-z0-9]{1,8}$/i.exec(key)?.[0]??'.jpg'}`;
    created.push(target);
    await s3.send(new CopyObjectCommand({Bucket:bucket,Key:target,CopySource:fromBucket+'/'+key.split('/').map(encodeURIComponent).join('/')}));
    return target;
  };
  try {
    const result=[];
    for(const photo of originals) {
      if(typeof photo.storageKey!=='string')throw Error('画像情報を確認できません。');
      const fromBucket=typeof photo.sourceBucket==='string'?photo.sourceBucket:bucket;
      const storageKey=await copy(photo.storageKey,fromBucket);
      const thumbnailKey=typeof photo.thumbnailKey==='string'?await copy(photo.thumbnailKey,fromBucket):storageKey;
      const mediumKey=typeof photo.mediumKey==='string'?await copy(photo.mediumKey,fromBucket):storageKey;
      const rest={...photo};delete rest.sourceBucket;
      result.push({...rest,storageKey,thumbnailKey,mediumKey,sourceSystem:null,sourceUrl:null});
    }
    return result;
  }catch(error){await Promise.all(created.map(removeInventoryImage));throw error;}
}

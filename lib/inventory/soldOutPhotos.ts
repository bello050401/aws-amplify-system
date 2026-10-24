import 'server-only';
import {getPhotoRegistrationWebAdapter,getWebTrustedClaims} from '@/lib/photoRegistration/webAdapter';
import {photoAssetS3Key,extensionForMimeType} from '@/lib/photoRegistration/types';
import {copyInventoryImage,removeInventoryImage} from './imageServerOps';

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
  const copied=new Map<string,string>();
  const copy=async(key:string,fromBucket?:string)=>{
    const sourceKey=`${fromBucket??'inventory'}:${key}`;
    const existing=copied.get(sourceKey);if(existing)return existing;
    // Use the same signed-in storage permissions as ordinary inventory duplication.
    const target=await copyInventoryImage(key,fromBucket);
    created.push(target);
    copied.set(sourceKey,target);
    return target;
  };
  try {
    const result=[];
    for(const photo of originals) {
      if(typeof photo.storageKey!=='string')throw Error('画像情報を確認できません。');
      const fromBucket=typeof photo.sourceBucket==='string'?photo.sourceBucket:undefined;
      const storageKey=await copy(photo.storageKey,fromBucket);
      const thumbnailKey=typeof photo.thumbnailKey==='string'?await copy(photo.thumbnailKey,fromBucket):storageKey;
      const mediumKey=typeof photo.mediumKey==='string'?await copy(photo.mediumKey,fromBucket):storageKey;
      const rest={...photo};delete rest.sourceBucket;
      result.push({...rest,storageKey,thumbnailKey,mediumKey,sourceSystem:null,sourceUrl:null});
    }
    return result;
  }catch(error){await Promise.all(created.map(removeInventoryImage));throw error;}
}

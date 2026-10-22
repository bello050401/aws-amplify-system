"use server";
import {getInventoryRole,canEditInventory} from '@/lib/amplify/requireInventoryUser';
import {getInventoryDetail} from '@/lib/inventory/queries';
import {getListingDraftForInventory} from '@/lib/listing/service';
import {listInventoryPhotoAssetsAction} from './photoRegistration';
import {buildListingImageCandidates} from '@/lib/photoRegistration/inventoryListingAdapter';
import {resolveListingImageDownloadUrl} from '@/lib/listing/mercari/csv/buildExportRows';
export async function getListingOriginalDownloadAction(inventoryId:string,key:string){
 try{
  if(!canEditInventory(await getInventoryRole()))throw Error('画像を確認する権限がありません。');
  const [item,draft,photos]=await Promise.all([getInventoryDetail(inventoryId),getListingDraftForInventory(inventoryId),listInventoryPhotoAssetsAction(inventoryId)]);
  if(!item)throw Error('商品が見つかりません。');
  const candidate=buildListingImageCandidates(item.images,photos.ok?photos.value.assets:[],draft?.images).find(c=>c.ref.storageKey===key);
  const justUploaded=key.startsWith('inventory/listing-upload/'+inventoryId+'/')&&/^inventory\/listing-upload\/[a-f0-9-]+\/[a-f0-9-]+\.(jpg|png|webp)$/i.test(key);
  if(!candidate&&!justUploaded)throw Error('この商品の画像を選び直してください。');
  const ref=candidate?.ref??{storageKey:key,source:'INVENTORY' as const};
  const url=await resolveListingImageDownloadUrl(ref,item.sku+'_'+key.split('/').pop());
  if(!url)throw Error('元画像を取得できません。');
  return {ok:true as const,url};
 }catch(e){return {ok:false as const,message:e instanceof Error?e.message:'元画像を取得できません。'};}
}

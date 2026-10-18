"use server";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getListingDraftForInventory } from "@/lib/listing/service";
import { resolveListingImageDownloadUrl } from "@/lib/listing/mercari/csv/buildExportRows";
import { listInventoryPhotoAssetsAction } from "./photoRegistration";
import { buildListingImageCandidates } from "@/lib/photoRegistration/inventoryListingAdapter";
import { createListingWorkflow, ListingError, type Source, type Receipt, type ImageRef } from "@/lib/listing/independentShop/workflow";
import {commonCategory,commonChannelPrice} from '@/lib/listing/commonSettings';
import { independentShopConnection } from "@/lib/listing/independentShop/connection";
async function source(id:string):Promise<Source>{
 const [item,draft]=await Promise.all([getInventoryDetail(id),getListingDraftForInventory(id)]);
 if(!item||!draft)throw new ListingError("商品とEC出品の下書きを保存してから確認してください。");
 const refs=[...draft.images].sort((a,b)=>a.sortOrder-b.sortOrder);
 const photo=refs.some(i=>i.source==="PHOTO_ASSET")?await listInventoryPhotoAssetsAction(id):null;
 if(photo&&!photo.ok)throw new ListingError("撮影画像を確認できません。画像の接続状況を確認してください。");
 const candidates=buildListingImageCandidates(item.images,photo?.ok?photo.value.assets:[]);
 for(const ref of refs){
  const matching=candidates.find(c=>c.available&&c.ref.storageKey===ref.storageKey&&(c.ref.source||"INVENTORY")===(ref.source||"INVENTORY")&&(!ref.photoAssetId||c.ref.photoAssetId===ref.photoAssetId));
  // Branded images are persisted as explicit selections in this inventory's saved draft.
  const savedBrandImage=ref.source!=="PHOTO_ASSET"&&/^inventory\/listing-branded\/[a-f0-9-]{36}\.jpg$/.test(ref.storageKey);
  if(!matching&&!savedBrandImage)throw new ListingError("この商品の出品画像として確認できない画像があります。画像を選び直して保存してください。");
 }
 const category=commonCategory(draft.commonCategoryId);
 return {id:item.id,name:draft.title||item.name,description:draft.description||"",price:commonChannelPrice(draft,'INDEPENDENT')??0,sku:item.sku||"",quantity:item.quantity,version:item.updatedAt+":"+draft.updatedAt,images:refs,...(category?{categories:[category.independent.id]}:{})};
}
async function image(ref:ImageRef){
 const signed=await resolveListingImageDownloadUrl(ref);if(!signed)throw new ListingError("商品画像を取得できません。");
 const url=new URL(signed);if(url.protocol!=="https:"||!/(^|\.)s3[.-][a-z0-9.-]*\.amazonaws\.com$/.test(url.hostname)||url.username||url.password)throw new ListingError("商品画像の保存先を確認できません。");
 const r=await fetch(url,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(20000)});
 if(!r.ok||Number(r.headers.get("content-length"))>10000000||!r.body)throw new ListingError("商品画像を取得できないか、10MBを超えています。");
 const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>10000000){await reader.cancel();throw new ListingError("画像は10MB以内にしてください。")}chunks.push(part.value);}
 return new Blob(chunks as BlobPart[],{type:r.headers.get("content-type")||"application/octet-stream"});
}
const workflow=()=>createListingWorkflow({role:getInventoryRole,source,client:independentShopConnection,image});
async function result<T>(job:()=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;error:string}>{
 try{return {ok:true,value:await job()}}catch(e){return {ok:false,error:e instanceof ListingError?e.message:"出品の処理を完了できませんでした。再読み込みして確認してください。"}}
}
export async function previewIndependentShopAction(id:string,stock:number){return result(()=>workflow().preview(id,stock));}
export async function uploadIndependentShopImageAction(id:string,stock:number,token:string,index:number){return result(()=>workflow().upload(id,stock,token,index));}
export async function saveIndependentShopAction(id:string,stock:number,token:string,receipts:Receipt[]){return result(()=>workflow().commit(id,stock,token,receipts));}
export async function previewIndependentShopPublicationAction(id:string){return result(()=>workflow().publicationPreview(id));}
export async function changeIndependentShopPublicationAction(id:string,token:string){return result(()=>workflow().changePublication(id,token));}

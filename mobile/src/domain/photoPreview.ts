import type { InventoryPhoto } from './inventory';
import { reusableThumbnail } from './thumbnailFreshness';

/** Cached gallery metadata can outlive its signed URLs. Never start those expired requests. */
export function initialPreviewPhotos(photos:InventoryPhoto[]|undefined,thumbnail:string|null,now=Date.now()):InventoryPhoto[] {
  const usable=(url:string|null|undefined)=>Boolean(url)&&(!/[?&]X-Amz-Date=/i.test(url!)||reusableThumbnail(url!,now));
  const result=(photos??[]).flatMap(photo=>{
    const full=usable(photo.fullUrl)?photo.fullUrl??null:null,url=usable(photo.url)?photo.url:null;
    return full||url?[{...photo,url:url??full,fullUrl:full}]:[];
  }).sort((a,b)=>Number(b.primary)-Number(a.primary)||Number(a.type==='DAMAGE')-Number(b.type==='DAMAGE'));
  return result.length?result:usable(thumbnail)?[{id:'preview-thumbnail',url:thumbnail,primary:true}]:[];
}

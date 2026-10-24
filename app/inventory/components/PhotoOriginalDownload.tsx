"use client";
import type {WebPhotoAssetView} from "@/lib/photoRegistration/webAdapter";
import {originalAvailable} from "@/lib/photoRegistration/originalRetention";
export function PhotoOriginalDownload({asset}:{asset:WebPhotoAssetView}){
 if(asset.isDeleted||asset.sourceType!=="PHOTO_STATION")return null;
 const o=asset.original;
 const available=originalAvailable(o);
 return <div className="rounded bg-slate-50 p-2 text-xs text-slate-600">
  <p className="font-medium">編集前の写真</p>
  {!o?<p>未アップロード（撮影機の更新前に保存された写真）</p>:
   o.purgedAt||Date.parse(o.expiresAt)<=Date.now()?<p>7日間の保管期限終了</p>:
   !o.uploadedAt?<p>アップロード未完了。撮影機で保存を再実行してください。</p>:
   <><p>保管期限：{new Date(o.expiresAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}</p>
   {available&&<a className="mt-1 inline-flex min-h-9 items-center rounded border border-blue-300 bg-white px-2 text-blue-700" href={"/api/inventory/photo-download?id="+encodeURIComponent(asset.id)+"&variant=original"} aria-label={"画像 "+(asset.sequence+1)+" の編集前写真をダウンロード"}>編集前写真をダウンロード</a>}</>}
 </div>;
}

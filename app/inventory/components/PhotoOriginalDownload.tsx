"use client";
import type {WebPhotoAssetView} from "@/lib/photoRegistration/webAdapter";
import {originalAvailable} from "@/lib/photoRegistration/originalRetention";
import {PhotoFileDownload} from "./PhotoFileDownload";
export function PhotoOriginalDownload({asset}:{asset:WebPhotoAssetView}){
 if(asset.isDeleted||asset.sourceType!=="PHOTO_STATION")return null;
 const o=asset.original;
 const available=originalAvailable(o);
 return <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3 text-xs leading-5 text-slate-600">
  <p className="font-medium">編集前の写真</p>
  {!o?<p className="text-amber-800">保管を確認できません。撮影機で保存を再実行してください。</p>:
   o.purgedAt||Date.parse(o.expiresAt)<=Date.now()?<p>7日間の保管期限終了</p>:
   !o.uploadedAt?<p>アップロード未完了。撮影機で保存を再実行してください。</p>:
   <><p>保管期限：{o.expiresAt?new Date(o.expiresAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"}):"商品に紐付けてから7日間"}</p>
   {available&&<PhotoFileDownload className="mt-1 inline-flex min-h-9 items-center rounded border border-blue-300 bg-white px-2 text-blue-700" href={"/api/inventory/photo-download?id="+encodeURIComponent(asset.id)+"&variant=original"} ariaLabel={"画像 "+(asset.sequence+1)+" の編集前写真をダウンロード"}>原本を保存（圧縮なし）</PhotoFileDownload>}</>}
 </div>;
}

"use client";
import {PhotoOriginalDownload} from "@/app/inventory/components/PhotoOriginalDownload";
import {PhotoFileDownload} from "@/app/inventory/components/PhotoFileDownload";
import {useRouter} from "next/navigation";
import {useRef,useState} from "react";
import {deletePhotoAssetAction} from "@/app/actions/photoRegistration";
import type {PhotoActorRole} from "@/lib/photoRegistration/types";
import type {WebPhotoAssetView} from "@/lib/photoRegistration/webAdapter";
const status:Record<string,string>={UPLOADING:"アップロード中",READY:"準備完了",FLAGGED:"要確認",DELETED:"削除済み",FAILED:"失敗"};
export function PhotoAssetGrid({batchId,assets,actorRole}:{batchId:string;assets:WebPhotoAssetView[];actorRole:PhotoActorRole;archived?:boolean}){
 const router=useRouter(), busy=useRef(false);
 const [target,setTarget]=useState<WebPhotoAssetView|null>(null),[pending,setPending]=useState(false),[error,setError]=useState("");
 const canDelete=actorRole==="STAFF"||actorRole==="ADMIN";
 async function confirmDelete(){
  if(!target||busy.current)return;busy.current=true;setPending(true);setError("");
  try{const result=await deletePhotoAssetAction(batchId,target.id);
   if(!result.ok){setError(result.message);return;}
   setTarget(null);router.refresh();
  }catch{setError("削除結果を確認できません。再度お試しください。");}
  finally{busy.current=false;setPending(false);}
 }
 return <>
 <ul className="grid grid-cols-1 gap-4 min-[440px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
 {assets.map(asset=><li key={asset.id} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
  <div className="flex items-center justify-between text-xs"><span className="font-semibold text-slate-900">写真 {asset.sequence+1}</span><span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-800">{asset.sourceType==="WEB_UPLOAD"?"手動登録":"編集後"}</span></div>
  <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-gray-100">
   {/* eslint-disable-next-line @next/next/no-img-element */}
   {asset.thumbnailUrl&&!asset.isDeleted?<img src={asset.thumbnailUrl} alt={"画像 "+(asset.sequence+1)} className="h-full w-full object-contain" loading="lazy"/>:<span className="text-xs text-gray-500">{asset.isDeleted?asset.purgedAt?"削除済み":"クラウドの削除を確認してください":"画像を表示できません"}</span>}
  </div>
  <p className="text-xs text-slate-600">{status[asset.status]??asset.status}</p>
  {!asset.isDeleted&&asset.processedUrl&&<PhotoFileDownload className="flex min-h-9 items-center justify-center rounded border border-blue-300 text-xs text-blue-700" href={"/api/inventory/photo-download?id="+encodeURIComponent(asset.id)} ariaLabel={"画像 "+(asset.sequence+1)+" をダウンロード"}>ダウンロード</PhotoFileDownload>}
  <PhotoOriginalDownload asset={asset}/>
  {canDelete&&(!asset.isDeleted||!asset.purgedAt)&&<button type="button" disabled={pending} onClick={()=>{setError("");setTarget(asset);}} aria-label={"画像 "+(asset.sequence+1)+" を削除"} className="min-h-9 rounded border border-red-300 text-xs text-red-700 disabled:opacity-50">{asset.isDeleted?"削除を再実行":"削除"}</button>}
 </li>)}
 </ul>
 {target&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><section role="alertdialog" aria-modal="true" aria-label="画像の削除確認" className="w-full max-w-sm rounded-xl bg-white p-5">
  <h3 className="font-bold">画像 {target.sequence+1} を削除しますか？</h3>
  {/* eslint-disable-next-line @next/next/no-img-element */}
  {target.thumbnailUrl&&<img src={target.thumbnailUrl} alt="削除する画像" className="my-3 h-48 w-full object-contain"/>}
  <p className="my-3 text-sm">この画像と縮小画像・保管中の編集前写真をクラウドから削除します。削除後は元に戻せません。</p>
  {error&&<p role="alert" className="my-3 text-sm text-red-700">{error}</p>}
  <div className="flex gap-3"><button autoFocus type="button" disabled={pending} onClick={()=>setTarget(null)} className="min-h-11 flex-1 rounded border">キャンセル</button><button type="button" disabled={pending} onClick={()=>void confirmDelete()} className="min-h-11 flex-1 rounded bg-red-700 text-white disabled:opacity-50">{pending?"削除中…":"削除する"}</button></div>
 </section></div>}
 </>;
}

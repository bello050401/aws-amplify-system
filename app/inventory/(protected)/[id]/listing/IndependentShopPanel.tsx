"use client";
import { useState } from "react";
import { previewIndependentShopAction,uploadIndependentShopImageAction,saveIndependentShopAction } from "@/app/actions/independentShop";
import type { Preview,Receipt } from "@/lib/listing/independentShop/workflow";
export function IndependentShopPanel({inventoryId,quantity}:{inventoryId:string;quantity:number}){
 const [stock,setStock]=useState(String(Math.min(1,Math.max(0,quantity))));
 const [preview,setPreview]=useState<Preview|null>(null),[receipts,setReceipts]=useState<Receipt[]>([]);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
 async function check(){setBusy(true);setError("");setMessage("");setPreview(null);setReceipts([]);try{const r=await previewIndependentShopAction(inventoryId,Number(stock));if(!r.ok){setError(r.error);return}setPreview(r.value)}catch{setError("通信できませんでした。時間をおいて確認してください。")}finally{setBusy(false)}}
 async function save(){
  if(!preview?.token)return;setBusy(true);setError("");const done=[...receipts];
  try{
   for(let index=done.length;index<preview.imageCount;index++){
    setMessage("画像を転送中 "+(index+1)+" / "+preview.imageCount);
    const r=await uploadIndependentShopImageAction(inventoryId,preview.stock,preview.token,index);
    if(!r.ok){setError(r.error);return}done.push(r.value);setReceipts([...done]);
   }
   setMessage("下書きを保存しています…");
   const saved=await saveIndependentShopAction(inventoryId,preview.stock,preview.token,done);
   if(!saved.ok){setError(saved.error);return}
   setMessage("BELLO自社サイトに下書きを保存しました。商品ID："+saved.value.id);setPreview(null);setReceipts([]);
  }catch{setError("通信が中断されました。取り込み内容を再確認し、保存結果を照合してから再試行してください。")}finally{setBusy(false)}
 }
 return <section className="mt-6 max-w-4xl rounded-xl border border-teal-200 bg-white p-5" aria-labelledby="independent-shop-heading">
  <h2 id="independent-shop-heading" className="text-base font-bold text-gray-900">BELLO自社サイトへ出品</h2>
  <p className="mt-2 text-sm text-gray-600">保存済みの出品下書きと選択した画像を取り込みます。送信後は自社サイトの下書きとなります。</p>
  <p className="mt-1 text-sm text-gray-600">自社サイトはオーナー限定で確認中です。販売に割り当てる数量を確認してください。</p>
  <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm font-medium">販売に割り当てる在庫<input className="mt-1 block w-32 rounded border border-gray-300 p-2" aria-label="自社サイトに割り当てる在庫" type="number" min="0" max={quantity} step="1" value={stock} disabled={busy} onChange={e=>{setStock(e.target.value);setPreview(null);setReceipts([]);setMessage("");setError("")}} /></label>
  <button type="button" className="rounded bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy||stock===""} onClick={check}>{busy?"処理中…":"取り込み内容を確認"}</button></div>
  {error&&<p role="alert" className="mt-4 whitespace-pre-wrap rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
  {message&&<p role="status" className="mt-4 break-words text-sm text-teal-800">{message}</p>}
  {preview&&<div className="mt-4 space-y-3 rounded bg-gray-50 p-4 text-sm">
   <p className="break-words font-semibold">{preview.name}</p>
   <p>価格：¥{preview.price.toLocaleString("ja-JP")} ／ 販売可能数：{preview.stock} ／ 画像：{preview.imageCount}枚</p>
   <p>{preview.remote?"登録済み商品を更新します。現在の販売可能数："+preview.remote.stock:"新しい商品として登録します。"}</p>
   <details><summary className="cursor-pointer">商品説明を確認</summary><p className="mt-2 whitespace-pre-wrap break-words">{preview.description||"説明なし"}</p></details>
   {!preview.connected?<p className="rounded bg-amber-50 p-3 text-amber-900">接続情報が未設定です。内容の確認まで行えます。接続設定が完了すると取り込めます。</p>:<><p className="text-gray-600">取り込むと自社サイト側は下書きになります。実在庫や他の販路の数量は変更されません。</p><button type="button" disabled={busy} onClick={save} className="rounded bg-teal-700 px-4 py-2 text-white disabled:opacity-50">{receipts.length?"画像転送の続きから下書きを保存":"確認した内容を下書きとして取り込む"}</button></>}
  </div>}
 </section>;
}

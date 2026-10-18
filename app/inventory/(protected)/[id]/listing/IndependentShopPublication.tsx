"use client";
import { useEffect, useState } from "react";
import { changeIndependentShopPublicationAction, previewIndependentShopPublicationAction } from "@/app/actions/independentShop";
import type { PublicationPreview } from "@/lib/listing/independentShop/workflow";

export function IndependentShopPublication({inventoryId,refreshKey}:{inventoryId:string;refreshKey:number}){
 const [state,setState]=useState<PublicationPreview|null>(null),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 async function check(){
  setBusy(true);setConfirm(false);setError("");setState(null);
  try{const r=await previewIndependentShopPublicationAction(inventoryId);if(r.ok)setState(r.value);else setError(r.error)}catch{setError("出品状態を確認できませんでした。通信状態を確認して再試行してください。")}finally{setBusy(false)}
 }
 useEffect(()=>{void check()},[inventoryId,refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
 async function change(){
  if(!state?.token)return;setBusy(true);setError("");setMessage("");
  try{
   const r=await changeIndependentShopPublicationAction(inventoryId,state.token);
   if(!r.ok){setError(r.error);setState(null);return}
   setMessage(r.value.status==="published"?"自社サイトへの出品を確認しました。":"自社サイトの出品停止を確認しました。");
   await check();
  }catch{setError("通信が中断されました。再実行前に「出品状態を確認」で結果を確認してください。");setState(null)}finally{setConfirm(false);setBusy(false)}
 }
 return <div className="mb-5 rounded-lg border border-gray-200 p-4 text-sm" aria-label="自社サイトの出品状態">
  <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-bold">自社サイトの出品状態</h3><button type="button" disabled={busy} onClick={check} className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50">出品状態を確認</button></div>
  {busy&&<p role="status" className="mt-3">確認・処理しています…</p>}
  {error&&<p role="alert" className="mt-3 text-red-700">{error}</p>}
  {message&&<p role="status" className="mt-3 text-teal-800">{message}</p>}
  {state?.remote?<div className="mt-3 space-y-2">
   <p className="font-semibold">{state.remote.status==="published"?"出品中":"停止中・下書き"}</p>
   <p className="break-words">{state.remote.name}</p>
   <p>{state.remote.price?.toLocaleString("ja-JP")}円 · 数量 {state.remote.stock} · 画像 {state.remote.images?.length??0}枚</p>
   <p className="text-xs text-gray-500">商品ID：{state.remote.id}</p>
   <button type="button" disabled={busy||!state.token} onClick={()=>setConfirm(true)} className="rounded bg-teal-700 px-4 py-2 text-white disabled:opacity-50">{state.target==="published"?"自社サイトに出品":"自社サイトの出品を停止"}</button>
  </div>:state&&<p className="mt-3 text-gray-600">未登録です。下の取り込み内容を確認して、下書きを保存してください。</p>}
  {confirm&&state?.remote&&<div role="dialog" aria-modal="true" aria-label="自社サイトの出品確認" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
   <div className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-xl">
    <h3 className="text-lg font-bold">{state.target==="published"?"自社サイトに出品しますか？":"自社サイトの出品を停止しますか？"}</h3>
    <p className="break-words">{state.remote.name}</p><p>{state.remote.price?.toLocaleString("ja-JP")}円 · 数量 {state.remote.stock} · 画像 {state.remote.images?.length??0}枚</p>
    <p>{state.target==="published"?"自社サイトに保存済みの内容で出品します。":"この商品のみ非公開に戻します。"}</p>
    <div className="flex justify-end gap-3"><button type="button" disabled={busy} onClick={()=>setConfirm(false)} className="rounded border px-4 py-2">キャンセル</button><button type="button" disabled={busy} onClick={change} className="rounded bg-teal-700 px-4 py-2 text-white disabled:opacity-50">{busy?"処理中…":state.target==="published"?"確認した商品を出品する":"確認した商品の出品を停止する"}</button></div>
   </div>
  </div>}
 </div>;
}

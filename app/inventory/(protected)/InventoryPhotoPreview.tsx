"use client";

import {useEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import type {InventoryPhoto} from "@/mobile/src/domain/inventory";

/** Fetch the authenticated gallery only for the opened item, never for every row. */
export function InventoryPhotoPreview({id, name, onClose}: {id:string; name:string; onClose:()=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [photos,setPhotos] = useState<InventoryPhoto[]>([]);
  const [index,setIndex] = useState(0), [attempt,setAttempt] = useState(0);
  const [loading,setLoading] = useState(true), [error,setError] = useState("");
  const [zoom,setZoom] = useState(false);
  useEffect(()=>{
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return ()=>previous?.focus();
  },[]);
  useEffect(()=>{
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),15000);
    let current = true;
    setLoading(true);setError("");setPhotos([]);setIndex(0);setZoom(false);
    void fetch(`/api/mobile/inventory/${encodeURIComponent(id)}?photos=only`,{signal:controller.signal,cache:"no-store"})
      .then(async response=>{
        if(!response.ok)throw Error();
        const value=await response.json();
        if(value.gallery?.id!==id || !Array.isArray(value.gallery.photos))throw Error();
        if(!current)return;
        const gallery:InventoryPhoto[]=value.gallery.photos;
        setPhotos([...gallery].sort((a,b)=>Number(b.primary)-Number(a.primary)));
        if(!value.gallery.photosComplete)setError("一部の写真を取得できませんでした。再試行できます。");
      })
      .catch(()=>{if(current)setError("写真を取得できませんでした。再試行してください。");})
      .finally(()=>{clearTimeout(timeout);if(current)setLoading(false);});
    return ()=>{current=false;clearTimeout(timeout);controller.abort();};
  },[id,attempt]);
  function move(delta:number){setIndex(value=>(value+delta+photos.length)%photos.length);setZoom(false);}
  const photo=photos[index],url=photo?.fullUrl??photo?.url;
  return createPortal(<dialog ref={dialog} aria-label="商品写真" onCancel={event=>{event.preventDefault();onClose();}}
    onClick={event=>{if(event.target===event.currentTarget)onClose();}}
    onKeyDown={event=>{if(photos.length>1&&event.key==="ArrowRight")move(1);if(photos.length>1&&event.key==="ArrowLeft")move(-1);}}
    className="m-auto h-[min(850px,92dvh)] w-[min(1000px,94vw)] overflow-hidden rounded-lg p-0 shadow-2xl backdrop:bg-black/70">
    <div className="flex h-full flex-col bg-white">
      <header className="flex shrink-0 items-start gap-4 border-b p-4">
        <h2 className="min-w-0 flex-1 whitespace-normal break-words text-base font-semibold">{name}</h2>
        <button type="button" autoFocus onClick={onClose} className="min-h-10 shrink-0 rounded border px-4 text-sm">閉じる</button>
      </header>
      {error&&<div role="alert" className="bg-amber-50 px-4 py-2 text-sm">{error}<button type="button" onClick={()=>setAttempt(value=>value+1)} className="ml-3 min-h-9 underline">再試行</button></div>}
      <div className="min-h-0 flex-1 overflow-auto bg-gray-100 p-3">
        {loading?<p role="status" className="p-8 text-center">写真を読み込んでいます…</p>:url?
          <button type="button" aria-label={zoom?"写真を画面に合わせる":"写真をさらに拡大"} onClick={()=>setZoom(value=>!value)} className={zoom?"block min-h-full min-w-full cursor-zoom-out":"flex h-full w-full cursor-zoom-in items-center justify-center"}>
            {/* Full resolution is downloaded only after opening this viewer. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={name} className={zoom?"mx-auto max-w-none":"max-h-full max-w-full object-contain"} onError={()=>setError("写真を表示できませんでした。再試行してください。")}/>
          </button>:<p className="p-8 text-center text-gray-500">{error?"写真を読み直してください。":"登録されている写真はありません。"}</p>}
      </div>
      <footer className="flex shrink-0 items-center justify-center gap-5 border-t p-3 text-sm">
        <button type="button" onClick={()=>move(-1)} disabled={photos.length<2} className="min-h-10 rounded border px-4 disabled:opacity-40">前の写真</button>
        <span aria-live="polite">{photos.length?index+1:0} / {photos.length}</span>
        <button type="button" onClick={()=>move(1)} disabled={photos.length<2} className="min-h-10 rounded border px-4 disabled:opacity-40">次の写真</button>
      </footer>
    </div>
  </dialog>,document.body);
}

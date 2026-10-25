"use client";
import {useEffect,useRef,useState,type ReactNode} from "react";

// Fetch the authorized file without navigating away from the inventory screen.
// S3 transfers the bytes directly, avoiding the backend's response-size limit.
export function PhotoFileDownload({href,children,className,ariaLabel}:{href:string;children:ReactNode;className?:string;ariaLabel?:string}){
 const active=useRef<AbortController|null>(null),objectUrl=useRef<string|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const release=()=>{if(timer.current)clearTimeout(timer.current);if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=null;};
 useEffect(()=>()=>{active.current?.abort();release();},[]);
 async function download(){
  if(active.current)return;const controller=new AbortController();active.current=controller;setBusy(true);setError("");release();
  try{
   const info=await fetch(href,{headers:{Accept:"application/json"},cache:"no-store",signal:controller.signal});
   if(!info.ok)throw Error("download unavailable");
   const {url,fileName}=await info.json() as {url:string;fileName:string};
   const response=await fetch(url,{credentials:"omit",cache:"no-store",signal:controller.signal});
   if(!response.ok)throw Error("download failed");
   const blob=await response.blob();if(controller.signal.aborted)return;
   const object=URL.createObjectURL(blob);objectUrl.current=object;
   const link=document.createElement("a");link.href=object;link.download=fileName;document.body.appendChild(link);link.click();link.remove();
   timer.current=setTimeout(release,60000);
  }catch{if(!controller.signal.aborted)setError("写真を保存できませんでした。通信状況と保管期限を確認して、もう一度お試しください。");}
  finally{if(active.current===controller){active.current=null;if(!controller.signal.aborted)setBusy(false);}}
 }
 return <><button type="button" disabled={busy} aria-label={ariaLabel} className={className} onClick={()=>void download()}>{busy?"保存準備中…":children}</button>{error&&<span role="alert" className="block text-xs text-red-700">{error}</span>}</>;
}

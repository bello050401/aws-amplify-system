'use client';
import {SESSION_INVALID_MESSAGE} from './sessionInvalidation';
let users=0,dispose:(()=>void)|undefined;
/** Mask restored/hidden pages until the server has rechecked this device.
 * Keep the form mounted on temporary network failure; never discard drafts. */
export function retainBrowserSessionGuard(){
 if(typeof window==='undefined')return()=>{};
 users++;
 if(!dispose){
  let checking=false,disposed=false,overlay:HTMLDivElement|null=null,previousVisibility='';
  const mask=()=>{if(overlay)return;previousVisibility=document.body.style.visibility;document.body.style.visibility='hidden';overlay=document.createElement('div');overlay.setAttribute('role','status');overlay.style.cssText='visibility:visible;position:fixed;inset:0;z-index:2147483647;background:white;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:20px;color:#243247;font:18px sans-serif';overlay.textContent='ログイン状態を確認しています…';document.body.appendChild(overlay)};
  const show=()=>{overlay?.remove();overlay=null;document.body.style.visibility=previousVisibility};
  const check=async()=>{
   if(disposed||checking||document.visibilityState==='hidden')return;
   checking=true;mask();
   try{
    const response=await fetch('/api/security-session',{cache:'no-store',credentials:'same-origin'});
    if(disposed)return;
    if(response.ok){show();return;}
    if(response.status===401||response.status===403){window.location.replace('/security?returnTo='+encodeURIComponent(location.pathname+location.search));return;}
    throw Error('temporarily unavailable');
   }catch{
    if(disposed)return;mask();overlay!.replaceChildren(document.createTextNode('接続を確認できません。入力内容はこの画面に保持しています。'));
    const button=document.createElement('button');button.textContent='再確認';button.style.cssText='padding:14px 28px;border:1px solid #2563eb;border-radius:8px;background:white;color:#2563eb';button.onclick=()=>void check();overlay!.appendChild(button);
   }finally{checking=false;}
  };
  const visibility=()=>{if(document.visibilityState==='hidden')mask();else void check()};
  const pageshow=(e:PageTransitionEvent)=>{if(e.persisted)void check()};
  const online=()=>void check();
  const invalid=(event:MessageEvent)=>{if(event.source===navigator.serviceWorker.controller&&event.data?.type===SESSION_INVALID_MESSAGE){mask();void check()}};
  navigator.serviceWorker?.addEventListener('message',invalid);
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',mask);window.addEventListener('pageshow',pageshow);window.addEventListener('offline',online);window.addEventListener('online',online);
  dispose=()=>{disposed=true;navigator.serviceWorker?.removeEventListener('message',invalid);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',mask);window.removeEventListener('pageshow',pageshow);window.removeEventListener('offline',online);window.removeEventListener('online',online);if(overlay)show()};
 }
 return()=>{users--;if(users===0){dispose?.();dispose=undefined}};
}

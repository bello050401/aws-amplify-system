import React,{useState,useSyncExternalStore} from 'react';
import {notify,subscribe,snapshot} from '../inventory-edit-ui/store';
let mode='normal',sequence=0;
function navigate(url:string,replace=false){
  const requested=++sequence;
  const commit=()=>{if(requested!==sequence)return; if(replace)history.replaceState({},'',url);else history.pushState({},'',url);notify();};
  if(mode==='blocked')return;
  if(mode==='slow')setTimeout(commit,20000);else commit();
}
const router={refresh:notify,push:(url:string)=>navigate(url),replace:(url:string)=>navigate(url,true)};
export const useRouter=()=>router;
export function useSearchParams(){useSyncExternalStore(subscribe,snapshot);return new URLSearchParams(location.search);}
export function NavigationFaultControl(){const [value,setValue]=useState(mode);return <label className="ml-4">検証通信 <select aria-label="検証通信" value={value} onChange={e=>{mode=e.target.value;setValue(mode);}}><option value="normal">通常</option><option value="slow">20秒遅延</option><option value="blocked">応答なし</option></select></label>;}
export default function Link({href,children,...props}:any){return <a href={href} {...props} onClick={e=>{props.onClick?.(e);if(!e.defaultPrevented){e.preventDefault();router.push(href);}}}>{children}</a>;}

export const usePathname=()=>location.pathname;

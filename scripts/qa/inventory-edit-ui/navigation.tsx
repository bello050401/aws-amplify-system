import React,{useSyncExternalStore} from 'react';
import {notify,subscribe,snapshot} from './store';
const router={refresh:notify,push:(url:string)=>{history.pushState({},'',url);notify();},replace:(url:string)=>{history.replaceState({},'',url);notify();}};
export const useRouter=()=>router;
export function useSearchParams(){useSyncExternalStore(subscribe,snapshot);return new URLSearchParams(location.search);}
export default function Link({href,children,...props}:any){return <a href={href} {...props} onClick={e=>{props.onClick?.(e);if(!e.defaultPrevented){e.preventDefault();router.push(href);}}}>{children}</a>;}

'use client';
import {useEffect,useId,useRef,useState} from 'react';
export function CategoryMultiSelect({value,onChange,options}:{value:string[];onChange:(ids:string[])=>void;options:{id:string;name:string}[]}) {
 const [open,setOpen]=useState(false),[query,setQuery]=useState('');
 const root=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null),id=useId();
 useEffect(()=>{if(!open)return;search.current?.focus();const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
 const toggle=(key:string)=>onChange(value.includes(key)?value.filter(v=>v!==key):[...value,key]);
 return <div ref={root} className="relative" onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.stopPropagation();}}}>
  <label className="mb-1 block text-sm text-gray-600" id={id+'-label'}>カテゴリ（複数選択）</label>
  <button type="button" aria-labelledby={id+'-label'} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)} className="flex min-h-11 w-full items-center justify-between gap-2 rounded border border-gray-300 bg-white px-3 py-2 text-left">
   <span className="flex flex-wrap gap-1">{value.length?value.map(key=><span key={key} className="rounded bg-blue-50 px-2 py-1 text-sm text-blue-900">{options.find(o=>o.id===key)?.name??'現在のカテゴリ'}</span>):<span className="text-gray-500">カテゴリを選択</span>}</span><span aria-hidden>⌄</span>
  </button>
  {open&&<div id={id} className="absolute z-30 mt-1 w-full rounded border border-gray-300 bg-white p-2 shadow-lg">
   <input ref={search} aria-label="カテゴリを検索" value={query} onChange={e=>setQuery(e.target.value)} placeholder="カテゴリを検索" className="mb-2 min-h-10 w-full rounded border px-3"/>
   <div className="max-h-64 overflow-y-auto">{options.filter(o=>o.name.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase())).map(o=><label key={o.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-3 hover:bg-blue-50"><input type="checkbox" checked={value.includes(o.id)} onChange={()=>toggle(o.id)} className="h-4 w-4"/>{o.name}</label>)}</div>
   <div className="mt-2 flex items-center justify-between border-t pt-2"><span className="text-sm text-gray-500">{value.length}件選択</span><button type="button" className="min-h-10 rounded bg-blue-600 px-5 text-white" onClick={()=>{setOpen(false);setQuery('');}}>完了</button></div>
  </div>}
 </div>;
}

"use client";
import {useMemo,useState} from "react";
import {INVENTORY_LIST_COLUMNS,dynamicColumnDefsFrom} from "@/lib/inventory/listColumns";
import type {CustomFieldDefinitionRow} from "@/lib/inventory/queries";
import {useInventoryListColumns} from "../../useInventoryListColumns";
export function ListColumnSettings({customFieldDefs}:{customFieldDefs:CustomFieldDefinitionRow[]}){
 const dynamic=useMemo(()=>dynamicColumnDefsFrom(customFieldDefs),[customFieldDefs]);
 const {visibility,order,setVisibility,setOrder,reset,hydrated}=useInventoryListColumns(dynamic);
 const [query,setQuery]=useState(''),[drag,setDrag]=useState<string|null>(null);
 const byKey=new Map([...INVENTORY_LIST_COLUMNS,...dynamic].map(c=>[c.key,c]));
 const ordered=order.map(k=>byKey.get(k)).filter((c):c is NonNullable<typeof c>=>Boolean(c));
 function moveTo(key:string,target:string){if(key===target)return;const next=order.filter(k=>k!==key);next.splice(order.indexOf(target),0,key);setOrder(next);}
 function step(key:string,delta:number){const i=order.indexOf(key),j=i+delta;if(j>=0&&j<order.length){const next=[...order];[next[i],next[j]]=[next[j],next[i]];setOrder(next);}}
 return <div className="space-y-4 text-sm">
  <p className="text-gray-500">表示する項目を選び、矢印またはドラッグで左右の順序を変えられます。設定はこのブラウザに保存されます。</p>
  <div className="flex flex-wrap items-center gap-2"><input type="search" aria-label="表示項目を検索" placeholder="項目名で探す" value={query} onChange={e=>setQuery(e.target.value)} className="min-w-0 flex-1 rounded-lg border px-3 py-2"/>
   <button type="button" className="rounded border px-3 py-2" onClick={()=>setVisibility(Object.fromEntries(ordered.map(c=>[c.key,true])))}>すべて表示</button><button type="button" className="rounded border px-3 py-2" onClick={reset}>初期設定</button></div>
  <p className="text-xs text-gray-500">{ordered.filter(c=>visibility[c.key]).length}項目を表示 · 物品名は必ず表示します</p>
  <ul className="divide-y rounded-lg border">{ordered.filter(c=>c.label.includes(query)).map(col=>{const index=order.indexOf(col.key);return <li key={col.key} draggable={hydrated} onDragStart={e=>{setDrag(col.key);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDrag(null)} onDragOver={e=>{if(drag)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(drag)moveTo(drag,col.key);setDrag(null);}} className="flex items-center gap-3 bg-white px-3 py-2">
   <span aria-hidden="true" className="cursor-grab text-gray-400">⠿</span>
   <label className="flex min-w-0 flex-1 items-center gap-3"><input type="checkbox" aria-label={col.label+'を表示'} checked={visibility[col.key]??col.defaultVisible} onChange={e=>setVisibility({...visibility,[col.key]:e.target.checked})} disabled={!hydrated||col.key==='name'} className="h-4 w-4 accent-teal-800"/><span className="break-words">{col.label}</span></label>
   <button type="button" onClick={()=>step(col.key,-1)} disabled={!hydrated||index===0} aria-label={col.label+'を上へ'} className="h-9 w-9 rounded border disabled:opacity-30">↑</button>
   <button type="button" onClick={()=>step(col.key,1)} disabled={!hydrated||index===ordered.length-1} aria-label={col.label+'を下へ'} className="h-9 w-9 rounded border disabled:opacity-30">↓</button>
  </li>;})}</ul>
 </div>;
}

'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {DirectEditProvider} from '@/app/inventory/(protected)/DirectEditProvider';
import {InventoryBulkControls} from '@/app/inventory/(protected)/InventoryBulkPanel';
import {useInventorySelection} from '@/app/inventory/(protected)/InventorySelectionProvider';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import type {InventoryListRow,MasterOption} from '@/lib/inventory/queries';
export function StaffInventoryEditList({rows,categories,q,offset,total}:{rows:InventoryListRow[];categories:MasterOption[];q:string;offset:number;total:number}){
 const selection=useInventorySelection(),router=useRouter(),[text,setText]=useState(q),[pending,start]=useTransition(),composing=useRef(false),timer=useRef<ReturnType<typeof setTimeout>>();
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 const href=(word:string,page=0)=>'/staff-inventory-edit?'+new URLSearchParams({q:word,offset:String(page)});
 const search=(word:string)=>{clearTimeout(timer.current);start(()=>router.replace(href(word),{scroll:false}));};
 const all=rows.length>0&&rows.every(r=>selection.selected.has(r.id)),some=rows.some(r=>selection.selected.has(r.id));
 const names=new Map(categories.map(c=>[c.id,c.name]));
 return <DirectEditProvider rows={rows}><main className="min-h-dvh bg-[#F8F6F1] pb-[calc(6rem+env(safe-area-inset-bottom))] text-[#263D3C]">
  <form className="sticky top-0 z-20 flex gap-2 bg-[#F8F6F1] p-3" onSubmit={event=>{event.preventDefault();if(!composing.current)search(text);}}>
   <input aria-label="商品名・管理番号で検索" placeholder="商品名・管理番号" value={text} className="min-h-11 min-w-0 flex-1 rounded-xl border bg-white px-3 text-base" onCompositionStart={()=>{composing.current=true;clearTimeout(timer.current);}} onCompositionEnd={e=>{composing.current=false;const value=e.currentTarget.value;timer.current=setTimeout(()=>search(value),250);}} onKeyDown={e=>{if(e.key==='Enter'&&(composing.current||e.nativeEvent.isComposing))e.preventDefault();}} onChange={e=>{setText(e.target.value);clearTimeout(timer.current);if(!composing.current){const value=e.target.value;timer.current=setTimeout(()=>search(value),250);}}}/>
   <button className="min-h-11 rounded-xl bg-[#263D3C] px-4 text-white" type="submit">検索</button>
  </form>
  <InventoryBulkControls categories={categories} embedded/>
  <div className="flex items-center justify-between p-3 text-sm"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-teal-800" checked={all} ref={node=>{if(node)node.indeterminate=some&&!all;}} onChange={()=>selection.toggleAll(rows.map(r=>r.id))}/>このページを選択（{rows.length}件）</label><span aria-live="polite">{pending?'検索中…':`${total.toLocaleString()}件`}</span></div>
  <ul className="divide-y border-y bg-white">{rows.map(row=><li key={row.id} className={selection.selected.has(row.id)?'bg-teal-50':''}><label className="flex cursor-pointer items-center gap-3 px-3 py-4"><input type="checkbox" className="h-5 w-5 shrink-0 accent-teal-800" checked={selection.selected.has(row.id)} onChange={()=>selection.toggle(row.id)} aria-label={`${row.name}を選択`}/>{row.mainImageSignedUrl?<img src={row.mainImageSignedUrl} alt="" loading="lazy" decoding="async" width={64} height={64} className="h-16 w-16 shrink-0 rounded-lg object-cover"/>:<span className="h-16 w-16 shrink-0 rounded-lg bg-gray-100"/>}<div className="min-w-0 flex-1"><div className="mb-1 flex flex-wrap gap-1">{inventoryCategoryIds(row).map(id=><span key={id} className="rounded bg-gray-100 px-1.5 text-xs">{names.get(id)??'現在のカテゴリ'}</span>)}</div><p className="break-words text-sm font-medium leading-6">{row.name}</p><p className="text-xs text-gray-500">{row.sku} ・ {row.quantity}点</p></div></label></li>)}</ul>
  {!rows.length&&<p className="p-6 text-center text-sm">該当する在庫はありません。</p>}
  <nav aria-label="在庫ページ" className="flex items-center justify-between gap-3 p-3"><button className="min-h-11 rounded-lg border bg-white px-4 disabled:opacity-40" disabled={!offset||pending} onClick={()=>start(()=>router.push(href(q,Math.max(0,offset-50)),{scroll:true}))}>前へ</button><span className="text-sm">{total?offset+1:0}–{Math.min(offset+50,total)} / {total}</span><button className="min-h-11 rounded-lg border bg-white px-4 disabled:opacity-40" disabled={offset+50>=total||pending} onClick={()=>start(()=>router.push(href(q,offset+50),{scroll:true}))}>次へ</button></nav>
 </main></DirectEditProvider>;
}

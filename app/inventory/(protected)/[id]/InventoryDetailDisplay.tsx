"use client";
import {useRef,useState,useEffect} from 'react';
import {useInventoryView} from '../../useInventoryView';
import {orderedVisibleOptions} from '@/lib/inventory/viewPreferences';
import type {DetailInfoRow} from './DetailInfoTable';
export type DetailDisplayGroup={title:string;rows:DetailInfoRow[]};
export function InventoryDetailDisplay({groups}:{groups:DetailDisplayGroup[]}){
 const {view,change,error}=useInventoryView(),[open,setOpen]=useState(false),[query,setQuery]=useState('');
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
 const fields=groups.flatMap(group=>group.rows.map(row=>({...row,id:group.title+':'+row.label,group:group.title})));
 const ordered=orderedVisibleOptions(fields,view.detailOrder,[]),visible=ordered.filter(f=>!view.detailHidden.includes(f.id));
 function move(id:string,step:number){const ids=ordered.map(f=>f.id),i=ids.indexOf(id),j=i+step;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];change({detailOrder:ids});}
 return <div>
  <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">物品情報</h3><button type="button" onClick={()=>setOpen(true)} className="rounded-lg border px-3 py-2 text-sm">表示項目・順序</button></div>
  {visible.length<fields.length&&<p className="mb-2 text-xs text-gray-500">{fields.length-visible.length}項目を非表示にしています</p>}
  <table className="w-full border-collapse text-sm"><tbody>{visible.map((f,i)=><tr key={f.id} className="border-b border-gray-100"><th className="w-[160px] py-2 pr-3 text-left align-top text-xs font-normal text-gray-500">{(i===0||visible[i-1].group!==f.group)&&<span className="mb-1 block text-[11px] font-semibold text-teal-800">{f.group}</span>}{f.label}</th><td className="whitespace-pre-wrap break-words py-2 align-top text-gray-900">{f.value}</td></tr>)}</tbody></table>
  <dialog ref={dialog} onCancel={()=>setOpen(false)} onClose={()=>setOpen(false)} aria-labelledby="detail-display-title" className="max-h-[85vh] w-[620px] max-w-[calc(100vw-32px)] rounded-xl p-0 shadow-xl backdrop:bg-black/30">
   <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-white p-4"><h2 id="detail-display-title" className="font-semibold">在庫詳細の表示項目・順序</h2><button type="button" onClick={()=>setOpen(false)} className="rounded border px-3 py-2">閉じる</button></header>
   <div className="space-y-3 p-4"><p className="text-sm text-gray-500">このブラウザで開く商品の詳細に適用します。非表示にしても登録内容は残り、編集画面で確認できます。</p>
    <input type="search" aria-label="詳細の表示項目を検索" placeholder="項目名で探す" value={query} onChange={e=>setQuery(e.target.value)} className="w-full rounded border p-2"/>
    <div className="divide-y">{ordered.filter(f=>f.label.includes(query)).map(f=><div key={f.id} className="flex items-center gap-2 py-2"><label className="flex min-w-0 flex-1 items-center gap-3"><input type="checkbox" aria-label={f.group+'：'+f.label+'を表示'} checked={!view.detailHidden.includes(f.id)} onChange={e=>change({detailHidden:e.target.checked?view.detailHidden.filter(k=>k!==f.id):[...view.detailHidden,f.id]})}/><span><span className="block text-xs text-gray-500">{f.group}</span>{f.label}</span></label><button type="button" aria-label={f.group+'：'+f.label+'を上へ'} disabled={ordered[0]?.id===f.id} onClick={()=>move(f.id,-1)} className="h-9 w-9 rounded border disabled:opacity-30">↑</button><button type="button" aria-label={f.group+'：'+f.label+'を下へ'} disabled={ordered.at(-1)?.id===f.id} onClick={()=>move(f.id,1)} className="h-9 w-9 rounded border disabled:opacity-30">↓</button></div>)}</div>
    <button type="button" onClick={()=>change({detailHidden:[],detailOrder:[]})} className="text-sm underline">詳細の表示と順序を初期設定に戻す</button>{error&&<p role="alert" className="text-red-700">{error}</p>}
   </div>
  </dialog>
 </div>;
}

"use client";
import {useState} from 'react';
export function SelectedInventoryExport({ids,disabled}:{ids:string[];disabled:boolean}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function download(format:'csv'|'xlsx'){
  const fixed=[...ids];setBusy(true);setError('');
  try {const response=await fetch('/api/inventory/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:fixed,format})});if(!response.ok)throw Error(await response.text());
   const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='BELLO_選択した在庫.'+format;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);setOpen(false);
  }catch(e){setError(e instanceof Error?e.message:'出力に失敗しました。');}finally{setBusy(false);}
 }
 return <div className="relative"><button type="button" disabled={disabled||busy} onClick={()=>setOpen(!open)} className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-40">{busy?'出力中…':'選択商品を出力'}</button>
  {open&&<div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border bg-white p-4 shadow-lg"><p className="mb-3 text-sm">選択した{ids.length}件だけを出力</p><div className="flex gap-2">{(['csv','xlsx'] as const).map(format=><button key={format} type="button" disabled={busy} onClick={()=>void download(format)} className="rounded border px-4 py-2 text-sm">{format==='csv'?'CSV':'Excel'}</button>)}<button type="button" disabled={busy} onClick={()=>setOpen(false)} className="text-xs underline">閉じる</button></div>{error&&<p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}</div>}
 </div>;
}

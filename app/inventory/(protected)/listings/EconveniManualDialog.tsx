"use client";
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {ListingOverviewRow} from '@/lib/listing/service';
import type {ManualSyncResult} from '@/app/actions/econveniManualSync';
import {titleSimilarity,productTitleMatchesQuery,sameTitleWithoutNotes,differentTitleNotes,type ExternalProduct,type ManualSyncData} from '@/lib/listing/econveni/manualSyncModel';
import {EC_CHANNELS,EC_CHANNEL_LABEL} from '@/lib/listing/ecManagement';
import {formatJstDateTime} from '@/lib/inventory/formatJst';

export type ManualSyncInput={action:'load'|'refresh'|'link'|'unlink';inventoryId?:string;productId?:string;version?:string;fingerprint?:string;confirmed?:boolean;revision?:number};
const button='rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm disabled:opacity-40 hover:bg-slate-50';
const primary=button.replace(' bg-white','')+' border-blue-600 bg-blue-600 text-white hover:bg-blue-700';
export function EconveniManualDialog({rows,run,renderPhoto,onClose,onChanged}:{rows:ListingOverviewRow[];run:(i:ManualSyncInput)=>Promise<ManualSyncResult>;renderPhoto:(row:ListingOverviewRow)=>ReactNode;onClose:()=>void;onChanged:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),inflight=useRef(false);
 const [data,setData]=useState<ManualSyncData>({snapshot:null,links:[]}),[fingerprints,setFingerprints]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [query,setQuery]=useState(''),[remoteQuery,setRemoteQuery]=useState(''),[showLinked,setShowLinked]=useState(false);
 const [selected,setSelected]=useState<ListingOverviewRow|null>(null),[candidate,setCandidate]=useState<ExternalProduct|null>(null),[confirmed,setConfirmed]=useState(false),[unlink,setUnlink]=useState(false),[limit,setLimit]=useState(30);
 const [ownPhotoReady,setOwnPhotoReady]=useState(false),[remotePhotoReady,setRemotePhotoReady]=useState(false);
 async function execute(input:ManualSyncInput){
  if(inflight.current)return;inflight.current=true;setBusy(true);setError('');setNotice('');
  try{const result=await run(input);if(!result.ok){setError(result.message);return;}setData(result.data);setFingerprints(result.fingerprints);
   if(input.action!=='load'){setNotice(input.action==='refresh'?'eコンビニの状態を取得しました。':input.action==='link'?'紐付けを保存しました。出品状態を一覧へ反映しました。':'紐付けを解除しました。');onChanged();setCandidate(null);setConfirmed(false);setUnlink(false);}
  }catch{setError('結果を確認できませんでした。「保存情報を再読込」で確認してください。');}
  finally{setBusy(false);inflight.current=false;}
 }
 useEffect(()=>{dialog.current?.showModal();void execute({action:'load'});},[]); // eslint-disable-line react-hooks/exhaustive-deps
 const eligible=rows.filter(r=>!r.archived&&r.quantity>0&&r.categories?.some(c=>c==='販売中'||c==='出品中'));
 const visible=eligible.filter(r=>showLinked||!data.links.some(l=>l.inventoryId===r.inventoryId)).filter(r=>productTitleMatchesQuery(r.name,r.displayId,query));
 const link=data.links.find(l=>l.inventoryId===selected?.inventoryId);
 const candidates=useMemo(()=>!selected?[]:(data.snapshot?.products??[]).filter(p=>(!p.inventoryMarker||p.inventoryMarker===selected.inventoryId)&&!data.links.some(l=>l.productId===p.productId&&l.inventoryId!==selected.inventoryId)).filter(p=>productTitleMatchesQuery(p.title,p.productId,remoteQuery)).map(p=>({p,score:titleSimilarity(selected.name,p.title)})).sort((a,b)=>b.score-a.score||b.p.productId.localeCompare(a.p.productId)),[selected,data,remoteQuery]);
 function choose(row:ListingOverviewRow){setSelected(row);setCandidate(null);setConfirmed(false);setUnlink(false);setRemoteQuery('');setLimit(30);setNotice('');setError('');}
 return <dialog ref={dialog} onCancel={e=>{e.preventDefault();if(!busy)onClose();}} aria-labelledby="econveni-manual-title" className="m-auto max-h-[94vh] w-[96vw] max-w-6xl rounded-2xl p-0 shadow-xl backdrop:bg-black/40">
  <div className="sticky top-0 z-10 border-b bg-white px-6 py-4"><div className="flex items-center justify-between gap-3"><h2 id="econveni-manual-title" className="text-xl font-bold">eコンビニ連携</h2><button className={button} disabled={busy} onClick={onClose}>閉じる</button></div>
   <p className="mt-2 text-sm text-slate-600">商品名と写真を見比べて、同じ商品を紐付けます。eコンビニで操作した後は「状態を取得」でBELLOの表示を更新できます。</p>
   <div className="mt-3 flex flex-wrap items-center gap-3"><button className={primary} disabled={busy} onClick={()=>void execute({action:'refresh'})}>{busy?'処理中…':'eコンビニの状態を取得'}</button><button className={button} disabled={busy} onClick={()=>void execute({action:'load'})}>保存情報を再読込</button><span className="text-xs text-slate-500">{data.snapshot?`取得 ${formatJstDateTime(data.snapshot.checkedAt)} · ${data.snapshot.products.length}商品 · 紐付け済み ${data.links.length}件`:'初回は「状態を取得」を押してください。'}</span></div>
   {error&&<p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}{notice&&<p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
  </div>
  <div className="grid min-h-[480px] grid-cols-1 md:grid-cols-[320px_1fr]">
   <section aria-label="BELLOの商品" className="border-r bg-slate-50 p-4"><h3 className="font-bold">1. BELLOの商品を選択</h3><p className="my-2 text-xs text-slate-600">販売中・出品中の在庫が対象です。</p><input aria-label="BELLO商品を検索" placeholder="商品名・管理番号" value={query} onChange={e=>setQuery(e.target.value)} className="w-full rounded-lg border px-3 py-2"/><label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={showLinked} onChange={e=>setShowLinked(e.target.checked)}/>紐付け済みも表示</label>
    <div className="max-h-[52vh] space-y-2 overflow-y-auto">{visible.slice(0,100).map(r=><button key={r.inventoryId} className={`flex w-full gap-3 rounded-lg border p-3 text-left ${selected?.inventoryId===r.inventoryId?'border-blue-500 bg-blue-50':'bg-white'}`} disabled={busy} onClick={()=>choose(r)}><div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-slate-100">{renderPhoto(r)}</div><div className="min-w-0"><span className="block text-xs text-slate-500">{r.displayId} · {r.quantity}点</span><span className="line-clamp-3 text-sm">{r.name}</span>{data.links.some(l=>l.inventoryId===r.inventoryId)&&<span className="text-xs text-green-700">紐付け済み</span>}</div></button>)}{!visible.length&&<p className="p-4 text-sm text-slate-500">対象の商品はありません。</p>}{visible.length>100&&<p className="text-xs">100件まで表示しています。商品名で絞り込んでください。</p>}</div>
   </section>
   <section aria-label="eコンビニの商品" className="p-5">{!selected?<p className="py-20 text-center text-slate-500">左から商品を選択してください。</p>:<>
    <h3 className="font-bold">2. eコンビニの商品と照合</h3><p className="mt-2 text-sm">{selected.displayId} {selected.name}</p>
    {link?<div className="my-4 rounded-lg border p-4"><p>紐付け済み：eコンビニ #{link.productId}</p><p className="my-2 text-sm">{link.remoteTitle}</p><p className="mb-3 text-xs text-slate-500">出品の停止・削除や在庫数量の変更は、この画面からは行いません。</p>{!unlink?<button className={button} disabled={busy} onClick={()=>setUnlink(true)}>紐付けを解除</button>:<><p className="mb-2 text-sm">この紐付けだけを解除します。両方の商品は残ります。</p><button className={button} disabled={busy} onClick={()=>setUnlink(false)}>キャンセル</button><button className={button+' ml-2 text-red-700'} disabled={busy} onClick={()=>void execute({action:'unlink',inventoryId:selected.inventoryId,revision:link.revision,confirmed:true})}>解除を確定</button></>}</div>:candidate?<>
     <div className="my-4 grid grid-cols-2 gap-4"><div><p className="mb-2 text-xs font-bold">BELLO · {selected.displayId}</p><div className="h-56 overflow-hidden rounded-lg bg-slate-50" onLoadCapture={e=>{if(e.target instanceof HTMLImageElement)setOwnPhotoReady(e.target.naturalWidth>0);}} onErrorCapture={()=>setOwnPhotoReady(false)}>{renderPhoto(selected)}</div><p className="mt-2 text-sm">{selected.name}</p></div><div><p className="mb-2 text-xs font-bold">eコンビニ · #{candidate.productId}</p><img src={candidate.imageUrl??''} alt={candidate.title} onLoad={()=>setRemotePhotoReady(true)} onError={()=>setRemotePhotoReady(false)} className="h-56 w-full rounded-lg bg-slate-50 object-contain" referrerPolicy="no-referrer"/><p className="mt-2 text-sm">{candidate.title}</p></div></div>
     {differentTitleNotes(selected.name,candidate.title)&&<p className="my-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">【】内は社内メモとして照合から除いています。元の商品名・メモはそのまま残ります。</p>}
     <p className="text-sm text-slate-600">BELLO：在庫 {selected.quantity}点 ／ eコンビニ：数量 {candidate.quantity} · 価格 {candidate.price.toLocaleString()}円</p>
     <label className="my-4 flex items-center gap-3 rounded-lg bg-blue-50 p-4 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy||!ownPhotoReady||!remotePhotoReady}/>商品名・写真・管理番号を確認し、同じ商品であることを確認しました</label>
     {(!ownPhotoReady||!remotePhotoReady)&&<p className="mb-3 text-sm text-amber-700">両方の写真が表示されてから確認できます。表示できない場合は候補に戻ってください。</p>}
     <div className="flex gap-3"><button className={button} disabled={busy} onClick={()=>{setCandidate(null);setConfirmed(false);}}>候補に戻る</button><button className={primary} disabled={busy||!confirmed||!ownPhotoReady||!remotePhotoReady} onClick={()=>void execute({action:'link',inventoryId:selected.inventoryId,productId:candidate.productId,version:data.snapshot?.version,fingerprint:fingerprints[candidate.productId],confirmed})}>この商品と紐付ける</button></div>
    </>:<>
     <input aria-label="eコンビニ商品を検索" placeholder="候補を商品名・eコンビニ番号で絞り込む" className="my-4 w-full rounded-lg border px-3 py-2" value={remoteQuery} onChange={e=>{setRemoteQuery(e.target.value);setLimit(30);}}/>
     <p className="mb-3 text-xs text-slate-500">【】内は社内メモとして除き、商品名が近い順に表示します。元の商品名・メモは残ります。写真と管理番号を確認して選んでください。</p>
     <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{candidates.slice(0,limit).map(({p})=><button key={p.productId} disabled={busy||!p.imageUrl} onClick={()=>{setOwnPhotoReady(false);setRemotePhotoReady(false);setCandidate(p);setConfirmed(false);}} className="rounded-xl border bg-white p-3 text-left hover:border-blue-500 disabled:opacity-40">
      {p.imageUrl?<img src={p.imageUrl} alt={p.title} className="h-36 w-full rounded-lg bg-slate-50 object-contain" loading="lazy" referrerPolicy="no-referrer"/>:<div className="h-36 p-4 text-sm">写真なし・紐付け不可</div>}
      <p className="mt-2 text-xs text-slate-500">#{p.productId} · {p.quantity}点</p>
      {sameTitleWithoutNotes(selected.name,p.title)&&differentTitleNotes(selected.name,p.title)&&<p className="mt-2 text-xs text-blue-700">【】を除いた商品名が一致</p>}
      <p className="my-2 line-clamp-3 text-sm">{p.title}</p>
      <div className="text-[11px] text-slate-500">{EC_CHANNELS.map(c=><p key={c}>{EC_CHANNEL_LABEL[c]}：{p.channels[c].state==='ACTIVE'?'出品中':p.channels[c].state==='EXCLUDED'?'対象外':'未出品・停止'}</p>)}</div>
     </button>)}</div>
     {candidates.length>limit&&<button className={button+' mt-4'} disabled={busy} onClick={()=>setLimit(n=>n+30)}>さらに表示</button>}
     {!candidates.length&&<p className="p-5 text-sm">候補がありません。取得・検索条件を確認してください。</p>}
    </>}
   </>}</section>
  </div>
 </dialog>;
}

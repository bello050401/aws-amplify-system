'use client';
import {useRef,useState} from 'react';
import type {OutboundBatch} from '../../../../lib/outbound/types';
import {arrivalStatus,arrivalLabel,isArrivalRow,type ArrivalPreview,type ArrivalChange,type ArrivalProduct} from '../../../../lib/outbound/arrivalTypes';

const endpoint='/api/inventory/outbound';
const button='min-h-12 rounded-xl border border-blue-600 px-4 py-3 text-blue-700 disabled:opacity-40';
const field='min-h-12 w-full rounded-lg border border-gray-300 bg-white p-2 text-base';
type Choice={locationId:string;categoryIds:string[]};
export function ArrivalPanel({batch,embedded,canEdit,disabled,onUpdated,request}:{batch:OutboundBatch;embedded:boolean;canEdit:boolean;disabled:boolean;onUpdated:(batch:OutboundBatch)=>Promise<void>;request:<T>(url:string,body?:unknown)=>Promise<T>}){
 const status=arrivalStatus(batch),[preview,setPreview]=useState<ArrivalPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [location,setLocation]=useState(''),[customCategories,setCustomCategories]=useState(false),[categories,setCategories]=useState<string[]>([]),[individual,setIndividual]=useState<Record<string,Choice>>({});
 const pending=useRef<{commandId:string;changes:ArrivalChange[]}|null>(null),lock=useRef(false);
 const choice=(item:ArrivalProduct):Choice=>individual[item.rowId]??{locationId:location,categoryIds:customCategories?categories:item.defaultCategoryIds};
 const name=(ids:string[],options:{id:string;name:string}[])=>ids.map(id=>options.find(o=>o.id===id)?.name??id).join('・')||'なし';
 async function open(){if(busy||disabled)return;setBusy(true);setError('');try{
  const data=await request<ArrivalPreview>(`${endpoint}?batch=${batch.id}&arrival=1`);setPreview(data);setLocation(data.locations.some(l=>l.id===data.batch.locationId)?data.batch.locationId:'');setCustomCategories(false);setCategories([]);setIndividual({});
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function apply(resume=false){if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   if(!resume&&preview)pending.current={commandId:crypto.randomUUID(),changes:preview.items.map(item=>({rowId:item.rowId,inventoryId:item.inventoryId,expectedUpdatedAt:item.updatedAt,...choice(item)}))};
   const command=pending.current??{commandId:batch.arrivalCommandId,changes:[]};
   const result=await request<{batch:OutboundBatch}>(endpoint,{action:'arrive',id:batch.id,confirmed:true,...command});pending.current=null;setPreview(null);await onUpdated(result.batch);
  }catch(e){setError((e as Error).message);setPreview(null);try{const data=await request<{batch:OutboundBatch}>(`${endpoint}?batch=${batch.id}`);await onUpdated(data.batch);if(data.batch.arrivalCommandId||arrivalStatus(data.batch)==='COMPLETED')pending.current=null;}catch{/* Retain the stable command after a lost response. */}}
  finally{lock.current=false;setBusy(false);}
 }
 const checkboxes=(ids:string[],change:(ids:string[])=>void,label:string)=><div role="group" aria-label={label} className="grid grid-cols-2 gap-2">{preview?.categories.map(c=><label key={c.id} className="flex min-h-12 items-center gap-2 rounded-lg border p-2 text-sm"><input className="h-5 w-5 shrink-0" type="checkbox" checked={ids.includes(c.id)} disabled={busy} onChange={e=>change(e.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id))}/>{c.name}</label>)}</div>;
 if(!status)return null;
 const failures=batch.rows.filter(row=>isArrivalRow(row)&&row.arrivalStatus!=='COMPLETED'&&row.arrivalError);
 return <section className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-3" aria-label="到着確認">
  <h3 className="font-semibold">{arrivalLabel(status)}</h3>
  {status==='COMPLETED'?<p className="text-sm">{batch.arrivalAt?new Date(batch.arrivalAt).toLocaleString('ja-JP'):''} に更新しました。<br/>出庫した商品だけに変更を反映しました。</p>:<p className="text-sm">受け取り後に、この出庫分の保管場所・カテゴリを変更します。{batch.rows.some(r=>r.arrivalStatus==='COMPLETED')&&` 更新済み ${batch.rows.filter(r=>r.arrivalStatus==='COMPLETED').length}件。`}</p>}
  {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
  {!!failures.length&&<ul className="space-y-2 text-sm text-red-800">{failures.map(r=><li key={r.id}>{r.splitSku??r.snapshot.sku}：{r.arrivalError}</li>)}</ul>}
  {busy&&<p role="status">確認しています。画面を閉じずにお待ちください。</p>}
  {batch.status!=='COMPLETED'&&status!=='COMPLETED'&&<p className="text-sm">出庫の完了処理後に到着確認できます。</p>}
  {canEdit&&batch.status==='COMPLETED'&&status!=='COMPLETED'&&<div className={embedded?'fixed inset-x-0 bottom-0 z-30 space-y-2 border-t bg-white p-3 pb-[max(12px,env(safe-area-inset-bottom))]':'space-y-2'}>
   {(status==='APPLYING'||status==='PARTIAL'||pending.current)&&<button className={button+' w-full bg-blue-600 !text-white'} disabled={busy||disabled} onClick={()=>apply(true)}>更新を再開</button>}
   {status!=='APPLYING'&&!pending.current&&<button className={button+' w-full bg-blue-600 !text-white'} disabled={busy||disabled} onClick={open}>{status==='PARTIAL'?'未完了の商品を確認・変更':'到着確認・一括変更'}</button>}
  </div>}
  {preview&&<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"><section role="dialog" aria-modal="true" aria-label="到着確認・一括変更" className="flex max-h-[94%] w-full max-w-2xl flex-col rounded-t-2xl bg-white sm:rounded-2xl">
   <header className="shrink-0 border-b p-4"><h2 className="text-lg font-semibold">到着確認・一括変更</h2><p className="text-sm">{batch.destinationName} · {preview.items.length}商品 · {preview.items.reduce((n,i)=>n+i.quantity,0)}点</p></header>
   <div className="space-y-5 overflow-y-auto p-4">
    <label className="grid gap-2 font-semibold">変更後の保管場所<select aria-label="変更後の保管場所" className={field} value={location} disabled={busy} onChange={e=>setLocation(e.target.value)}><option value="">選んでください</option>{preview.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <div className="space-y-2"><p className="font-semibold">変更後のカテゴリ</p><label className="flex min-h-12 items-center gap-3"><input type="radio" name="arrival-category-mode" checked={!customCategories} disabled={busy} onChange={()=>setCustomCategories(false)}/>移動予定だけ外す（他のカテゴリは維持）</label><label className="flex min-h-12 items-center gap-3"><input type="radio" name="arrival-category-mode" checked={customCategories} disabled={busy} onChange={()=>setCustomCategories(true)}/>全商品を同じカテゴリにする</label>{customCategories&&<>{checkboxes(categories,setCategories,'全商品のカテゴリ')}<p className="text-xs text-gray-500">複数選択できます。選択なしにするとカテゴリを外します。</p></>}</div>
    <h3 className="font-semibold">変更する内容</h3>
    <ul className="space-y-3">{preview.items.map(item=>{const target=choice(item);return <li key={item.rowId} className="space-y-2 rounded-xl border p-3 text-sm"><b>{item.name}</b><p className="text-gray-500">{item.sku} · {item.quantity}点</p>{item.error&&<p role="alert" className="text-red-800">{item.error}</p>}<p className="break-words">保管場所：{name([item.locationId],preview.locations)} → <strong>{name([target.locationId],preview.locations)}</strong><br/>カテゴリ：{name(item.categoryIds,preview.categories)} → <strong>{name(target.categoryIds,preview.categories)}</strong></p>
      <details><summary className="flex min-h-12 cursor-pointer items-center text-blue-700">この商品だけ変更する</summary><label className="my-2 flex min-h-12 items-center gap-3"><input type="checkbox" className="h-5 w-5" aria-label={item.sku+'を個別に設定'} checked={!!individual[item.rowId]} disabled={busy} onChange={e=>setIndividual(p=>{const next={...p};if(e.target.checked)next[item.rowId]={...target,categoryIds:[...target.categoryIds]};else delete next[item.rowId];return next;})}/>個別に設定</label>{individual[item.rowId]&&<div className="space-y-3"><select className={field} aria-label={item.sku+'の保管場所'} value={target.locationId} disabled={busy} onChange={e=>setIndividual(p=>({...p,[item.rowId]:{...target,locationId:e.target.value}}))}>{preview.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select>{checkboxes(target.categoryIds,ids=>setIndividual(p=>({...p,[item.rowId]:{...target,categoryIds:ids}})),item.sku+'のカテゴリ')}</div>}</details>
     </li>;})}</ul>
   </div>
   <footer className="shrink-0 space-y-3 border-t p-4 pb-[max(16px,env(safe-area-inset-bottom))]"><p className="text-sm">商品の受け取りと上記の変更内容を確認して確定してください。</p><div className="flex gap-3"><button className={button} disabled={busy} onClick={()=>setPreview(null)}>キャンセル</button><button className={button+' flex-1 bg-blue-600 !text-white'} disabled={busy||!preview.items.length||preview.items.some(i=>i.error||!choice(i).locationId)} onClick={()=>apply()}>変更を確定</button></div></footer>
  </section></div>}
 </section>;
}

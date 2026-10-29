'use client';
import {useRef,useState} from 'react';
import type {OutboundBatch} from '../../../../lib/outbound/types';
import {arrivalStatus,arrivalLabel,isArrivalRow} from '../../../../lib/outbound/arrivalTypes';
const endpoint='/api/inventory/outbound';
export function ArrivalPanel({batch,embedded,canEdit,disabled,onUpdated,request}:{batch:OutboundBatch;embedded:boolean;canEdit:boolean;disabled:boolean;onUpdated:(batch:OutboundBatch)=>Promise<void>;request:<T>(url:string,body?:unknown)=>Promise<T>}){
 const status=arrivalStatus(batch),[dialog,setDialog]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const command=useRef<string|null>(null),lock=useRef(false);
 async function apply(){if(lock.current)return;lock.current=true;setBusy(true);setError('');
  command.current??=batch.arrivalStatus==='APPLYING'&&batch.arrivalCommandId?batch.arrivalCommandId:crypto.randomUUID();
  try{
   const result=await request<{batch:OutboundBatch}>(endpoint,{action:'arrive',id:batch.id,confirmed:true,commandId:command.current});
   await onUpdated(result.batch);command.current=null;setDialog(false);
  }catch(e){setError((e as Error).message);setDialog(false);
   try{const fresh=await request<{batch:OutboundBatch}>(endpoint+'?batch='+batch.id);await onUpdated(fresh.batch);if(fresh.batch.arrivalStatus==='PARTIAL'||fresh.batch.arrivalStatus==='COMPLETED')command.current=null;}catch{/* Preserve the command after an uncertain response. */}
  }finally{lock.current=false;setBusy(false);}
 }
 if(!status)return null;
 const failures=batch.rows.filter(row=>isArrivalRow(row)&&row.arrivalStatus!=='COMPLETED'&&row.arrivalError);
 const button='min-h-12 rounded-xl border border-blue-600 px-5 py-3 text-blue-700 disabled:opacity-40';
 return <section className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4" aria-label="到着確認">
  <h3 className="font-semibold">{arrivalLabel(status)}</h3>
  <p className="text-sm leading-6">{status==='COMPLETED'?(batch.arrivalAt?new Date(batch.arrivalAt).toLocaleString('ja-JP')+' 更新完了':'更新完了'):'受け取り後に「確認」を押すと、この出庫分の移動予定カテゴリを外し、保管場所を変更します。他のカテゴリは維持します。'}</p>
  {!!failures.length&&<ul className="space-y-2 text-sm text-red-800">{failures.map(r=><li key={r.id}>{r.splitSku??r.snapshot.sku}：{r.arrivalError}</li>)}</ul>}
  {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
  {canEdit&&batch.status==='COMPLETED'&&status!=='COMPLETED'&&<div className={embedded?'sticky bottom-0 z-20 bg-blue-50 pt-2':''}><button className={button+' w-full bg-blue-600 !text-white sm:max-w-sm'} disabled={busy||disabled} onClick={()=>setDialog(true)}>{busy?'確認中…':'確認'}</button></div>}
  {dialog&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5"><section role="alertdialog" aria-modal="true" aria-label="変更の確認" className="w-full max-w-sm space-y-6 rounded-2xl bg-white p-6"><h2 className="text-lg font-semibold">変更してよろしいですか？</h2><div className="flex gap-3"><button autoFocus className={button+' flex-1'} disabled={busy} onClick={()=>setDialog(false)}>キャンセル</button><button className={button+' flex-1 bg-blue-600 !text-white'} disabled={busy} onClick={apply}>{busy?'確認中…':'確認'}</button></div></section></div>}
 </section>;
}

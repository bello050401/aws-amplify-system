'use client';
import {useEffect,useRef,useState} from 'react';
import {reviewEconveniNativeAction,enqueueEconveniNativeBatchAction,econveniNativeStatusAction,recheckEconveniNativeAction} from '@/app/actions/econveniNative';
import {NATIVE_LABEL,NATIVE_DESCRIPTION,type NativeRequest} from '@/lib/listing/econveni/nativeModel';
import {EC_CHANNEL_LABEL} from '@/lib/listing/ecManagement';
const button='min-h-10 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40';
type Reviews=Awaited<ReturnType<typeof reviewEconveniNativeAction>>;
export function EconveniNativeDialog({requests,onClose,onQueued}:{requests:NativeRequest[];onClose:()=>void;onQueued:(ids:string[])=>void}){
 const dialog=useRef<HTMLDialogElement>(null),inflight=useRef(false),ids=useRef(requests.map(()=>crypto.randomUUID()));
 const [reviews,setReviews]=useState<Reviews>([]),[busy,setBusy]=useState(true),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[terms,setTerms]=useState(false),[receipts,setReceipts]=useState<string[]>([]);
 useEffect(()=>{dialog.current?.showModal();let live=true;reviewEconveniNativeAction(requests).then(r=>{if(live)setReviews(r);}).catch(()=>{if(live)setError('確認内容を取得できませんでした。');}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[requests]);
 const termsRequired=requests.some(r=>r.channel==='YAHOO'&&r.operation==='PUBLISH');
 async function execute(){
  if(inflight.current)return;inflight.current=true;setBusy(true);setError('');const done:string[]=[];
  try{const results=await enqueueEconveniNativeBatchAction(reviews.flatMap((r,index)=>r.ok?[{...r.review,requestId:ids.current[index],confirmed,terms}]:[]));
   for(const result of results){if(result.ok)done.push(result.id);else setError(result.message);}setReceipts(done);if(done.length)onQueued(done);
  }catch{setError('受付結果を確認できません。同じ確認画面から再確認してください。');}
  finally{inflight.current=false;setBusy(false);}
 }
 return <dialog ref={dialog} aria-labelledby="econveni-native-title" onCancel={e=>{if(busy)e.preventDefault();else onClose();}} className="m-auto max-h-[90dvh] w-[min(720px,94vw)] rounded-2xl p-0 shadow-xl backdrop:bg-black/35">
  <div className="flex items-center justify-between border-b px-6 py-4"><h2 id="econveni-native-title" className="text-lg font-bold">eコンビニ操作の確認</h2><button className={button} disabled={busy} onClick={onClose}>閉じる</button></div>
  <div className="max-h-[64dvh] space-y-4 overflow-y-auto p-6">
   <p className="text-sm text-slate-600">受付後は画面を閉じて作業を続けられます。送信間隔を守り、順番に処理します。</p>
   {requests.some(r=>r.operation==='CLEAR')&&<p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">「消」はeコンビニの出品番号だけを解除します。ECの商品ページと販売状態は変わりません。出品中に解除すると、この紐付けから停止できなくなります。</p>}
   {requests.some(r=>r.operation==='STOP'&&r.channel!=='YAHOO')&&<p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">eコンビニの「止」は、BASE・メルカリShopsでは商品ページの削除です。売れた販売先のページは対象にできません。BASEを非公開にするだけの場合は、一覧の「詳細」から通常の出品停止を使ってください。</p>}
   {busy&&!reviews.length&&<p>商品と出品状態を確認中…</p>}
   {reviews.map((r,i)=><div className="rounded-xl border p-4" key={i}><p className="mb-2 text-xs text-slate-500">{EC_CHANNEL_LABEL[requests[i].channel]} · {NATIVE_LABEL[requests[i].operation]} — {NATIVE_DESCRIPTION[requests[i].operation]}</p>{r.ok?<><p className="font-semibold leading-6">{r.review.title}</p><p className="mt-2 text-sm text-slate-600">eコンビニ数量 {r.review.quantity}点 · 基準価格 {r.review.price.toLocaleString()}円</p></>:<p role="alert" className="text-sm text-amber-800">{r.message}</p>}</div>)}
   {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
   {receipts.length>0?<p role="status" className="rounded-lg bg-teal-50 p-4 font-semibold text-teal-900">{receipts.length}件を受け付けました。結果は一覧の「処理状況」に表示します。</p>:<><label className="flex gap-3 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>対象商品・販売先・操作内容を確認しました</label>{termsRequired&&<label className="flex gap-3 text-sm"><input type="checkbox" checked={terms} onChange={e=>setTerms(e.target.checked)} disabled={busy}/>Yahoo!オークションの利用規約・ガイドラインに同意して出品します</label>}</>}
  </div>
  <div className="flex justify-end gap-3 border-t bg-slate-50 px-6 py-4"><button className={button} disabled={busy} onClick={onClose}>{receipts.length?'作業に戻る':'キャンセル'}</button>{!receipts.length&&<button className={button+' !border-teal-800 !bg-teal-800 text-white'} disabled={busy||!confirmed||termsRequired&&!terms||reviews.length!==requests.length||reviews.some(r=>!r.ok)} onClick={()=>void execute()}>{busy?(reviews.length?'受付中…':'確認中…'):requests.length+'件を実行'}</button>}</div>
 </dialog>;
}
const key='bello-econveni-native-jobs-v1';
export function rememberNativeJobs(ids:string[]){try{const old=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify([...new Set([...ids,...(Array.isArray(old)?old:[])])].slice(0,100)));}catch{/* Status also remains on server. */}}
export function EconveniNativeProgress({refresh,onChanged}:{refresh:number;onChanged:()=>void}){
 const [rows,setRows]=useState<Awaited<ReturnType<typeof econveniNativeStatusAction>>>([]),[error,setError]=useState(''),[nonce,setNonce]=useState(0),[checking,setChecking]=useState('');const changed=useRef(onChanged);changed.current=onChanged;const previous=useRef('');
 useEffect(()=>{let active=true,timer:ReturnType<typeof setTimeout>|undefined;async function load(){try{const ids=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(ids))return;const result=await econveniNativeStatusAction(ids);if(!active)return;setRows(result);setError('');const completed=result.filter(r=>r.state==='EC_NATIVE_DONE').map(r=>r.id).sort().join();if(completed!==previous.current){previous.current=completed;changed.current();}if(result.some(r=>r.state==='EC_NATIVE_ACTIVE'))timer=setTimeout(load,10000);}catch{if(active){setError('処理状況を取得できません。画面を読み直して確認してください。');timer=setTimeout(load,15000);}}}void load();return()=>{active=false;if(timer)clearTimeout(timer);};},[refresh,nonce]);
 if(!rows.length&&!error)return null;
 const active=rows.filter(r=>r.state==='EC_NATIVE_ACTIVE').length,attention=rows.filter(r=>r.state==='EC_NATIVE_ATTENTION').length;
 return <details className="rounded-xl border bg-white p-4" open={attention>0}><summary className="cursor-pointer text-sm font-semibold">処理状況 · 処理中 {active}件 · 完了 {rows.length-active-attention}件{attention>0?' · 要確認 '+attention+'件':''}</summary>{error&&<p role="alert">{error}</p>}<div className="mt-3 max-h-72 overflow-y-auto divide-y">{rows.map(r=><div key={r.id} className="py-3 text-sm"><div className="flex justify-between gap-4"><span className="line-clamp-2">{r.title}</span><span className={'shrink-0 '+(r.state==='EC_NATIVE_DONE'?'text-teal-800':r.state==='EC_NATIVE_ATTENTION'?'text-amber-800':'text-blue-700')}>{r.state==='EC_NATIVE_DONE'?'完了':r.state==='EC_NATIVE_ATTENTION'?'要確認':'処理中'}</span></div><p className="mt-1 text-xs text-slate-500">{EC_CHANNEL_LABEL[r.channel as keyof typeof EC_CHANNEL_LABEL]} · {NATIVE_LABEL[r.operation as keyof typeof NATIVE_LABEL]}</p>{r.reason&&<p className="mt-1 text-amber-800">{r.reason}</p>}{r.state==='EC_NATIVE_ATTENTION'&&<button className={button+' mt-2'} disabled={!!checking} onClick={async()=>{setChecking(r.id);try{const result=await recheckEconveniNativeAction(r.id);setError(result.message??'');setNonce(n=>n+1);}catch{setError('再確認できませんでした。');}finally{setChecking('');}}}>結果を再確認</button>}</div>)}</div></details>;
}

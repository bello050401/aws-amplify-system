'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import type {DesktopJob,DesktopIssueCode} from '@/lib/saleCandidates/desktopJobModel';
type Image={key:string;url:string|null};
type Job=DesktopJob&{images:Image[]};
type Inventory={id:string;title:string;version:string;externalId:string|null;images:Image[]};
const labels={WAITING:'PC確認待ち',CLAIMED:'照合中',WRITE_STARTED:'変更結果の確認待ち',COMPLETE:'完了',ATTENTION:'確認が必要'};
export function DesktopSaleJobs(){
 const [jobs,setJobs]=useState<Job[]>([]),[cursor,setCursor]=useState<string|null>(null),[selected,setSelected]=useState<Job|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [observedTitle,setTitle]=useState(''),[evidenceRef,setEvidence]=useState(''),[imageKey,setImage]=useState(''),[titleMatch,setTitleMatch]=useState(false),[imageMatch,setImageMatch]=useState(false),[quantity,setQuantity]=useState(''),[remoteState,setRemoteState]=useState<'ACTIVE'|'STOPPED'>('ACTIVE');
 const [inventoryInput,setInventoryInput]=useState(''),[inventory,setInventory]=useState<Inventory|null>(null),[listingInput,setListingInput]=useState('');
 const [issueCode,setIssueCode]=useState<DesktopIssueCode>('DESKTOP_OPERATION_FAILED');
 async function load(more=false){setBusy(true);setError('');try{const r=await fetch('/api/sale-candidates/desktop-jobs'+(more&&cursor?'?cursor='+encodeURIComponent(cursor):''),{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);setJobs(v=>more?[...v,...d.jobs]:d.jobs);setCursor(d.cursor);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 useEffect(()=>{void load();},[]);
 function choose(j:Job){setSelected(j);setTitle('');setEvidence('');setImage('');setTitleMatch(false);setImageMatch(false);setQuantity('');setInventory(null);setListingInput('');setError('');}
 async function inspectInventory(){setBusy(true);setError('');try{let id=inventoryInput.trim();try{const u=new URL(id);id=u.pathname.match(/\/inventory\/([^/]+)/)?.[1]??id;}catch{}const r=await fetch('/api/sale-candidates/desktop-jobs?inventoryId='+encodeURIComponent(id),{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);setInventory(d.inventory);setImage('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function act(action:string){if(!selected)return;setBusy(true);setError('');try{
  const identified=selected.purpose==='IDENTIFY_SALE';
  const evidence={snapshot:selected.snapshot,inventoryId:identified?inventory?.id:selected.inventoryId,inventoryVersion:identified?inventory?.version:selected.inventoryVersion,externalId:identified?listingInput.trim():selected.externalId,orderId:selected.orderId,orderLineId:selected.orderLineId,observedTitle,expectedImageKey:imageKey,titleMatched:titleMatch,imageMatched:imageMatch,observedEvidenceRef:evidenceRef,observedAt:new Date().toISOString(),...(selected.purpose==='STOCK'?{observedQuantity:quantity===''?undefined:Number(quantity),observedState:remoteState}:{})};
  const r=await fetch('/api/sale-candidates/desktop-jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Bello-Sale-Desktop':'1'},body:JSON.stringify({id:selected.id,action,lease:selected.lease,evidence,code:issueCode})}),d=await r.json();if(!r.ok)throw Error(d.error+(d.code?' ('+d.code+')':''));
  setSelected(d.job);setJobs(v=>v.map(j=>j.id===d.job.id?d.job:j));if(action==='start-write'){setEvidence('');setQuantity('');setTitleMatch(false);setImageMatch(false);}
  if(action==='report-error')setError(d.operational?'問題を記録しました。再ログインや時間を置いた確認が必要です。変更は繰り返しません。':d.reported?'問題を一度だけ修復受付へ記録しました。変更は繰り返しません。':'問題は保存しましたが、修復受付への送信はまだ確認できません。');
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const images=selected?.purpose==='IDENTIFY_SALE'?inventory?.images??[]:selected?.images??[];
 const ready=!!selected?.lease&&titleMatch&&imageMatch&&!!imageKey&&!!observedTitle&&evidenceRef.trim().length>=8;
 return <div className="mx-auto max-w-6xl space-y-5 p-5">
  <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">PCの商品照合・数量変更</h1><Link href="/inventory/sale-candidates" className="text-blue-700 underline">売却管理へ戻る</Link></div>
  <p className="text-sm text-slate-600">メルカリの注文・商品画面と、BELLOの写真・商品名を照合します。未完了の処理は続きから確認できます。</p>
  {error&&<p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error}</p>}
  <div className="grid gap-5 lg:grid-cols-[320px_1fr]"><section className="space-y-3"><button onClick={()=>void load()} disabled={busy} className="rounded border px-3 py-2">受付を更新</button>
  {jobs.map(j=><button key={j.id} onClick={()=>choose(j)} className={'block w-full rounded border p-3 text-left '+(selected?.id===j.id?'border-blue-600 bg-blue-50':'')}><b className="block">{j.title}</b><span className="text-sm">{j.purpose==='IDENTIFY_SALE'?'注文の商品特定':j.purpose==='VERIFY_SALE'?'売却前の照合':j.targetQuantity===0?'出品停止':'数量 '+j.targetQuantity+' へ変更'} / {labels[j.state]}</span><small className="block">{j.state==='COMPLETE'?'完了 '+(j.completedAt?new Date(j.completedAt).toLocaleString('ja-JP'):'記録済み'):j.state==='ATTENTION'?'再試行停止':<>PC確認 {j.attempts}/4 回・次回 {new Date(j.nextAt).toLocaleString('ja-JP')}</>}</small></button>)}
  {!jobs.length&&<p>このページに受付はありません。</p>}{cursor&&<button disabled={busy} onClick={()=>void load(true)} className="rounded border px-3 py-2">続きを表示</button>}</section>
  <section className="space-y-4 rounded border p-4">{!selected?<p>確認する受付を選んでください。</p>:<>
   <h2 className="font-semibold">{selected.title}</h2><p>注文: {selected.orderId} / {labels[selected.state]}</p>
   {selected.orderUrl&&<a href={selected.orderUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">メルカリShopsの注文画面を開く</a>}
   {selected.inventoryId!=='UNRESOLVED'&&<Link href={'/inventory/'+selected.inventoryId} target="_blank" className="block text-blue-700 underline">BELLOの在庫ページを開く</Link>}
   {selected.state==='COMPLETE'?<p className="text-green-800">完了記録を保存済みです。同じ指示や変更は繰り返しません。</p>:selected.state==='ATTENTION'?<p>自動再試行を停止しています。売却管理で原因と商品を確認してください。</p>:<>
    <button disabled={busy} onClick={()=>void act('claim')} className="rounded bg-blue-700 px-4 py-2 text-white">{selected.writeStartedAt?'変更せず結果の再照合を開始':'この受付の照合を開始'}</button>
    <details className="rounded border p-3"><summary>問題を記録</summary><div className="mt-3 space-y-2"><label className="block">発生した問題<select className="block w-full rounded border p-2" value={issueCode} onChange={e=>setIssueCode(e.target.value as DesktopIssueCode)}><option value="AUTH_REQUIRED">ログイン・追加認証が必要</option><option value="RATE_LIMITED">利用先の待機・制限</option><option value="REMOTE_FORMAT_CHANGED">注文・商品画面の形式が変わった</option><option value="DESKTOP_OPERATION_FAILED">PCでの操作に問題が起きた</option></select></label><button disabled={busy||!selected.lease} onClick={()=>void act('report-error')} className="rounded border px-3 py-2">この問題を記録</button><p className="text-sm">処理の受付と変更記録を保持します。問題の記録で変更操作を再実行することはありません。</p>{selected.lastIssue&&<p className="text-sm">最終記録: {new Date(selected.lastIssue.at).toLocaleString('ja-JP')}</p>}</div></details>
    {selected.writeStartedAt&&<p role="status" className="rounded bg-amber-50 p-3">変更の試行を記録済みです。数量変更や停止を繰り返さず、現在の画面を読み直して結果だけを記録してください。</p>}
    {selected.purpose==='IDENTIFY_SALE'&&<div className="space-y-2"><p>注文画面の写真と商品名を見てBELLO在庫を特定し、該当する在庫ページを指定してください。同名だけでは確定しません。</p><label className="block">在庫ページのURLまたは内部番号<input className="block w-full rounded border p-2" value={inventoryInput} onChange={e=>setInventoryInput(e.target.value)}/></label><button disabled={busy} onClick={()=>void inspectInventory()} className="rounded border px-3 py-2">在庫と連携先を確認</button>{inventory&&<p>選択: {inventory.title} / 現在の連携先商品: {inventory.externalId??'未連携'}</p>}<label className="block">注文画面で確認したメルカリの商品番号<input className="block w-full rounded border p-2" value={listingInput} onChange={e=>setListingInput(e.target.value)}/></label><p className="text-sm">未連携の場合は、この商品番号と一致するeコンビニ商品との連携を確認してから照合結果を保存します。</p></div>}
    {selected.purpose!=='IDENTIFY_SALE'&&<p>メルカリ商品番号: {selected.externalId}</p>}
    <div className="flex flex-wrap gap-3">{images.map(i=><label key={i.key} className="max-w-48 rounded border p-2">{i.url?<img src={i.url} alt="照合元のBELLO商品画像" className="h-36 w-36 object-contain"/>:<span>画像を取得できません</span>}<input type="radio" name="photo" checked={imageKey===i.key} onChange={()=>setImage(i.key)}/> 実物写真が一致</label>)}</div>
    <label className="block">PC画面で読んだ商品名<input value={observedTitle} onChange={e=>setTitle(e.target.value)} className="block w-full rounded border p-2"/></label>
    <label className="block"><input type="checkbox" checked={titleMatch} onChange={e=>setTitleMatch(e.target.checked)}/> 商品名と注文・商品番号の一致を確認した</label>
    <label className="block"><input type="checkbox" checked={imageMatch} onChange={e=>setImageMatch(e.target.checked)}/> 注文／商品画面の写真をBELLOの選択画像と見比べた</label>
    <label className="block">保存した画面記録の参照先（ファイル名など）<input value={evidenceRef} onChange={e=>setEvidence(e.target.value)} className="block w-full rounded border p-2"/></label>
    {selected.purpose==='STOCK'&&<><p>目標: {selected.targetQuantity===0?'出品停止・数量0':'数量 '+selected.targetQuantity}。変更前に照合記録を保存し、許可が返ってから通常画面で1回だけ変更してください。</p>
    {!selected.writeStartedAt&&<button disabled={busy||!ready} onClick={()=>void act('start-write')} className="rounded bg-amber-700 px-4 py-2 text-white">照合記録を保存し、1回だけの変更を開始</button>}
    <label className="block">現在のPC画面で確認した数量<input type="number" min="0" value={quantity} onChange={e=>setQuantity(e.target.value)} className="block rounded border p-2"/></label><label className="block">現在の販売状態<select value={remoteState} onChange={e=>setRemoteState(e.target.value as 'ACTIVE'|'STOPPED')} className="ml-2 rounded border p-2"><option value="ACTIVE">出品中</option><option value="STOPPED">停止中</option></select></label></>}
    <button disabled={busy||!ready||selected.purpose==='IDENTIFY_SALE'&&(!inventory||!listingInput.trim())||selected.purpose==='STOCK'&&quantity===''} onClick={()=>void act('finish')} className="rounded bg-green-800 px-4 py-2 text-white">{selected.purpose==='STOCK'?'変更後の読取結果を保存':'商品名・写真の照合結果を保存'}</button>
   </>}
  </>}</section></div>
 </div>;
}

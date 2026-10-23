'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import {fetchRestageAction,registerRestageLotAction} from '@/app/actions/procurement';
import type {RestageLot} from '@/lib/procurement/restage';
type Row=RestageLot&{inventoryId:string|null;deleted?:boolean;state?:'pending'|'working'|'done'|'skipped'|'failed';error?:string};
const providers=['リステージオークション','トレファクライブネットオークション','ヤフーオークション'];
function defaultDate(){const date=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));date.setDate(date.getDate()-(date.getDay()+2)%7);return`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
export default function ProcurementPanel(){
  const [provider,setProvider]=useState(providers[0]),[date,setDate]=useState(defaultDate),[previewOnly,setPreviewOnly]=useState(false),[busy,setBusy]=useState(false),[rows,setRows]=useState<Row[]>([]),[run,setRun]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[parseErrors,setParseErrors]=useState<{goodsId:string;name:string;error:string}[]>([]);const working=useRef(false),stop=useRef(false);
  const patch=(goodsId:string,values:Partial<Row>)=>setRows(old=>old.map(r=>r.goodsId===goodsId?{...r,...values}:r));
  async function register(id:string,items:Row[]){
    let done=0,skipped=0,failed=0;
    for(const row of items){if(stop.current)break;if(row.inventoryId){patch(row.goodsId,{state:'skipped'});skipped++;continue;}patch(row.goodsId,{state:'working',error:undefined});setMessage(`${done+skipped+failed+1} / ${items.length} 件を登録中…`);
      try{const result=await registerRestageLotAction(id,row.goodsId);if(result.ok){patch(row.goodsId,{state:result.skipped?'skipped':'done',inventoryId:result.id});result.skipped?skipped++:done++;}else{failed++;patch(row.goodsId,{state:'failed',error:result.error});}}catch{failed++;patch(row.goodsId,{state:'failed',error:'保存結果を確認できません。再度取得すると重複せずに確認できます。'});}
    }
    setMessage(`${stop.current?'中断しました。':'取得が完了しました。'} 新規登録 ${done}件 ／ 登録済み ${skipped}件 ／ 失敗 ${failed}件`);
  }
  async function fetchLots(){
    if(working.current)return;working.current=true;stop.current=false;setBusy(true);setError('');setRows([]);setParseErrors([]);setRun('');setMessage('リステージへログインして、自社落札を取得しています…');
    try{const result=await fetchRestageAction(date);if(!result.ok){setError(result.error);setMessage('');return;}const items:Row[]=result.lots.map(r=>({...r,state:r.inventoryId?'skipped':'pending'}));setRows(items);setRun(result.runId);setParseErrors(result.errors);if(!previewOnly&&items.length)await register(result.runId,items);else setMessage(items.length?`${items.length}件取得しました。${previewOnly?'商品ページはまだ作成していません。':''}`:'この開催日の自社落札はありません。');}
    catch{setError('取得結果を確認できません。再度取得してください。');setMessage('');}finally{working.current=false;setBusy(false);}
  }
  async function registerPreview(){if(working.current||!run)return;working.current=true;stop.current=false;setBusy(true);try{await register(run,rows);}finally{working.current=false;setBusy(false);}}
  return <div className="space-y-6"><div className="flex flex-wrap gap-3" role="group" aria-label="仕入れ先">{providers.map(name=><button key={name} disabled={busy} onClick={()=>setProvider(name)} aria-pressed={provider===name} className={`rounded border px-4 py-3 font-medium ${provider===name?'border-blue-700 bg-blue-700 text-white':'border-gray-300 bg-white'} disabled:opacity-50`}>{name}</button>)}</div>
    {provider!==providers[0]?<p className="border border-gray-200 bg-gray-50 p-6">{provider}の取り込みは準備中です。</p>:<>
      <section className="space-y-4 rounded border border-gray-200 bg-white p-5"><div className="flex flex-wrap items-end gap-4"><label className="flex flex-col gap-2 font-medium">オークション開催日<input type="date" value={date} max={new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})} disabled={busy} onChange={e=>{setDate(e.target.value);setRows([]);setRun('');setMessage('');setError('');setParseErrors([]);}} className="min-h-12 rounded border border-gray-400 px-3"/></label><button disabled={busy||!date} onClick={fetchLots} className="min-h-12 rounded bg-blue-700 px-8 font-bold text-white disabled:opacity-50">{busy?'処理中…':'取得'}</button>{busy&&<button onClick={()=>{stop.current=true;setMessage('処理中の商品が完了したら中断します。');}} className="min-h-12 rounded border px-4">中断する</button>}</div>
      <p className="text-sm text-gray-600">オークション終了後、開催日を選んで「取得」を押してください。自社落札から商品ページを作成します。同じ商品は重複登録しません。</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={previewOnly} disabled={busy} onChange={e=>setPreviewOnly(e.target.checked)} className="h-5 w-5"/>取得内容の確認だけ行う（商品ページを作成しない）</label>
      <p className="text-sm text-gray-600">購入単価：落札価格 × 1.188。一山商品は点数で割り、1円未満を切り上げます。</p></section>
      {error&&<p role="alert" className="rounded bg-red-50 p-4 text-red-700">{error}</p>}{message&&<p role="status" aria-live="polite" className="rounded bg-blue-50 p-4 font-medium">{message}</p>}
      {!!parseErrors.length&&<section className="rounded border border-red-200 p-4"><h2 className="font-bold text-red-700">登録できなかった商品（{parseErrors.length}件）</h2>{parseErrors.map((r,i)=><p key={i}>{r.goodsId} {r.name}：{r.error}</p>)}</section>}
      {!!rows.length&&<section><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold">自社落札 {rows.length}商品・数量合計 {rows.reduce((n,r)=>n+r.quantity,0)}</h2>{previewOnly&&!busy&&rows.some(r=>!r.inventoryId)&&<button onClick={registerPreview} className="rounded bg-blue-700 px-4 py-3 font-bold text-white">この内容で商品ページを作成</button>}</div><div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr className="bg-gray-100">{['商品名','品目','数量','落札価格','購入単価','登録結果'].map(t=><th key={t} className="border-b p-3 text-left">{t}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.goodsId}><td className="max-w-md border-b p-3">{r.name}<small className="block text-gray-500">商品ID {r.goodsId} ／ 出品番号 {r.lotNumber}{r.isBundle?' ／ 一山':''}</small></td><td className="whitespace-nowrap border-b p-3">{r.itemType}</td><td className="whitespace-nowrap border-b p-3">{r.quantity}{r.unit}</td><td className="whitespace-nowrap border-b p-3">{r.hammerPrice.toLocaleString()}円</td><td className="whitespace-nowrap border-b p-3 font-bold">{r.purchasePrice.toLocaleString()}円</td><td className="border-b p-3">{r.inventoryId?<><span className="block text-green-700">{r.deleted?'登録済み（商品削除済み）':r.state==='skipped'?'登録済み':'登録完了'}</span>{!r.deleted&&<Link href={'/inventory/'+r.inventoryId} className="text-blue-700 underline">商品ページ</Link>}</>:r.state==='working'?'登録中…':r.error?<span className="text-red-700">{r.error}</span>:'未登録'}</td></tr>)}</tbody></table></div></section>}
    </>}
  </div>;
}

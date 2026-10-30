'use client';
import {useMemo,useRef,useState} from 'react';
import {fetchRestageAction,prepareRestageRunAction,registerRestageLotAction} from '@/app/actions/procurement';
import {completeRestageDraft} from '@/lib/procurement/restageDraft';
import {restageLedger} from '@/lib/procurement/restageTotals';
import YahooProcurementPanel from './YahooProcurementPanel';
import RestageReview,{rowProblem,type RestageRow as Row} from './RestageReview';
const providers=['リステージオークション','トレファクライブネットオークション','ヤフーオークション'];
function defaultDate(){const date=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));date.setDate(date.getDate()-(date.getDay()+2)%7);return`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
export default function ProcurementPanel(){
  const [provider,setProvider]=useState(providers[0]),[date,setDate]=useState(defaultDate),[previewOnly,setPreviewOnly]=useState(false),[busy,setBusy]=useState(false),[rows,setRows]=useState<Row[]>([]),[run,setRun]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[parseErrors,setParseErrors]=useState<{goodsId:string;name:string;error:string}[]>([]);
  const working=useRef(false),stop=useRef(false);
  const patch=(goodsId:string,values:Partial<Row>)=>setRows(old=>old.map(r=>r.goodsId===goodsId?{...r,...values}:r));
  const missing=rows.filter(row=>rowProblem(row)).length;
  const aggregation=useMemo(()=>{if(!rows.length||parseErrors.length)return{ledger:null,error:''};try{return{ledger:restageLedger(rows.map(r=>completeRestageDraft(r))),error:''};}catch(e){return{ledger:null,error:missing?'':(e as Error).message};}},[rows,parseErrors,missing]);
  async function register(id:string,items:Row[]){
    setMessage('入力内容と当日分の台帳合計を確認しています…');
    const plan=await prepareRestageRunAction(id,items.map(({goodsId,name,quantity,unit,hammerPrice,isBundle,itemType})=>({goodsId,name,quantity,unit,hammerPrice,isBundle,itemType})));
    if(!plan.ok){setError(plan.error);setMessage('入力内容を保持しています。修正して再度登録できます。');return;}
    setRun(plan.runId);
    const confirmed=items.map(row=>({...row,...plan.lots.find(l=>l.goodsId===row.goodsId)!}));setRows(confirmed);
    let done=0,skipped=0,failed=0,updated=0;
    for(const row of confirmed){
      if(stop.current)break;
      // Recheck registered rows too: a corrected pending lot may change the
      // auction-day total written to every page. The server skips unchanged rows.
      patch(row.goodsId,{state:'working',error:undefined});setMessage(`${done+skipped+failed+updated+1} / ${items.length} 件を登録中…`);
      try{const result=await registerRestageLotAction(plan.runId,row.goodsId);if(result.ok){patch(row.goodsId,{state:result.skipped?'skipped':'done',inventoryId:result.id,needsUpdate:false});'updated' in result&&result.updated?updated++:result.skipped?skipped++:done++;}else{failed++;patch(row.goodsId,{state:'failed',error:result.error});}}catch{failed++;patch(row.goodsId,{state:'failed',error:'保存結果を確認できません。再試行時は登録済みの商品を重複作成しません。'});}
    }
    setMessage(`${stop.current?'中断しました。':'登録処理が完了しました。'} 新規 ${done}件 ／ 登録済み ${skipped}件 ／ 台帳・初期値更新 ${updated}件 ／ 再試行が必要 ${failed}件`);
  }
  async function fetchLots(){
    if(working.current)return;working.current=true;stop.current=false;setBusy(true);setError('');setRows([]);setParseErrors([]);setRun('');setMessage('リステージへログインして、自社落札を取得しています…');
    try{
      const result=await fetchRestageAction(date);if(!result.ok){setError(result.error);setMessage('');return;}
      const items:Row[]=result.lots.map(r=>({...r,state:r.inventoryId?'skipped':'pending'}));setRows(items);setRun(result.runId);setParseErrors(result.errors);
      if(result.errors.length){setMessage('読み取れた商品を表示しました。商品ID・開催日などを確認できない行があるため、登録前に再取得してください。');return;}
      if(items.some(row=>rowProblem(row))){setMessage('商品情報を取得しました。「入力が必要」の商品だけ補ってから登録してください。購入単価と当日分の合計は自動計算します。');return;}
      if(!previewOnly&&items.length)await register(result.runId,items);
      else setMessage(items.length?`${items.length}件取得しました。内容を編集してから登録できます。商品ページはまだ作成していません。`:'この開催日の自社落札はありません。');
    }catch{setError('取得結果を確認できません。再度取得してください。');setMessage('');}finally{working.current=false;setBusy(false);}
  }
  async function registerPreview(){if(working.current||!run)return;working.current=true;stop.current=false;setBusy(true);setError('');try{await register(run,rows);}catch{setError('登録結果を確認できません。入力内容を保持しています。再試行してください。');}finally{working.current=false;setBusy(false);}}
  return <div className="space-y-6">
    <div className="flex flex-wrap gap-3" role="group" aria-label="仕入れ先">{providers.map(name=><button key={name} disabled={busy} onClick={()=>setProvider(name)} aria-pressed={provider===name} className={`rounded-lg border px-4 py-3 font-medium ${provider===name?'border-blue-700 bg-blue-700 text-white':'border-gray-300 bg-white'} disabled:opacity-50`}>{name}</button>)}</div>
    {provider===providers[2]?<YahooProcurementPanel/>:provider!==providers[0]?<section className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-6"><p>{provider}の取り込みは準備中です。</p><p>購入単価：落札金額 × 1.21（1円未満四捨五入）。</p></section>:<>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5"><div className="flex flex-wrap items-end gap-4"><label className="flex flex-col gap-2 font-medium">オークション開催日<input type="date" value={date} max={new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})} disabled={busy} onChange={e=>{setDate(e.target.value);setRows([]);setRun('');setMessage('');setError('');setParseErrors([]);}} className="min-h-12 rounded-lg border border-gray-300 px-3"/></label><button disabled={busy||!date} onClick={fetchLots} className="min-h-12 rounded-lg bg-blue-700 px-8 font-bold text-white disabled:opacity-50">{busy?'処理中…':'取得'}</button>{busy&&<button onClick={()=>{stop.current=true;setMessage('処理中の商品が完了したら中断します。');}} className="min-h-12 rounded-lg border px-4">中断する</button>}</div>
      <p className="text-sm text-gray-600">開催日を選んで、自社落札を取得します。同じ商品は重複登録しません。数量などが不明な場合は、読み取れた情報を表示し、必要な箇所だけ手入力で補えます。</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={previewOnly} disabled={busy} onChange={e=>setPreviewOnly(e.target.checked)} className="h-5 w-5"/>取得内容の確認だけ行う（商品ページを作成しない）</label>
      <p className="text-sm text-gray-600">保管場所「所沢事務所」・カテゴリ「補修待ち」で登録します。</p><p className="text-sm text-gray-600">購入単価：落札金額 × 1.188。一山商品は点数で割り、1円未満を四捨五入します。</p></section>
      {error&&<p role="alert" className="rounded-lg bg-red-50 p-4 text-red-700">{error}</p>}{message&&<p role="status" aria-live="polite" className="rounded-lg bg-blue-50 p-4 font-medium text-blue-900">{message}</p>}
      {!!parseErrors.length&&<section className="rounded-lg border border-red-200 p-4"><h2 className="font-bold text-red-700">元の一覧を確認できなかった商品（{parseErrors.length}件）</h2>{parseErrors.map((r,i)=><p key={i}>{r.goodsId} {r.name}：{r.error}</p>)}</section>}
      {!!rows.length&&<section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold">自社落札 {rows.length}商品</h2>{missing>0&&<span className="text-sm font-semibold text-amber-800">入力が必要：{missing}件</span>}</div>
        <RestageReview rows={rows} busy={busy} onChange={(id,v)=>{patch(id,{...v,error:undefined});setError('');}}/>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-5"><h2 className="font-bold">この開催日の古物台帳・仕入れ集計</h2>{aggregation.ledger?<><p className="mt-2">{aggregation.ledger.itemTypes}（合計{aggregation.ledger.quantity}点）</p><p className="mt-1 text-lg font-bold">仕入れ合計 {aggregation.ledger.purchaseTotal.toLocaleString()}円</p></>:<p className="mt-2 text-sm">{aggregation.error||'不明な数量・価格を入力すると、当日分の合計を計算します。'}</p>}<p className="mt-2 text-xs text-gray-600">全商品の集計を各商品ページの古物台帳へ記録します。在庫数量・購入単価は商品ごとの値です。</p></div>
        {rows.some(r=>!r.inventoryId||r.needsUpdate)&&<div className="flex flex-wrap items-center justify-end gap-3 pb-6">{missing>0&&<p className="text-sm text-amber-800">残り{missing}件の入力を確認してください</p>}<button disabled={busy||!aggregation.ledger} onClick={registerPreview} className="min-h-12 w-full rounded-lg bg-blue-700 px-6 py-3 font-bold text-white disabled:opacity-40 sm:w-auto">{busy?'処理中…':'この内容で登録・台帳を更新'}</button></div>}
      </section>}
    </>}
  </div>;
}

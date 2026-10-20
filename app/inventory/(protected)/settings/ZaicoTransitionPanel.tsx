"use client";
import {useState,useEffect,useCallback} from 'react';
import {getZaicoTransitionStatus,changeZaicoTransition} from '@/app/actions/zaicoTransition';

type Status=Awaited<ReturnType<typeof getZaicoTransitionStatus>>;
const labels:Record<string,string>={BASELINING:'初回同期中（ZAICOを基準）',ACTIVE:'双方向同期中',FINALIZING:'移行前の最終照合',STOPPED:'連携終了（BELLOを正本として運用）',DISABLED:'未開始'};
export function ZaicoTransitionPanel({onPhase}:{onPhase?:(phase:string)=>void}){
  const [status,setStatus]=useState<Status|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[minutes,setMinutes]=useState('5');
  const load=useCallback(async()=>{
    try{const next=await getZaicoTransitionStatus();setStatus(next);onPhase?.(next.control?.phase??'DISABLED');}
    catch(e){setMessage(e instanceof Error?e.message:'同期状態を取得できませんでした。');}
  },[onPhase]);
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer);},[load]);
  async function act(input:Parameters<typeof changeZaicoTransition>[0]){
    setBusy(true);setMessage('');
    try{const result=await changeZaicoTransition(input);setMessage(result.message);await load();}
    catch(e){setMessage(e instanceof Error?e.message:'操作に失敗しました。');}finally{setBusy(false);}
  }
  const control=status?.control;
  useEffect(()=>setMinutes(String(control?.pollMinutes??5)),[control?.pollMinutes]);
  const button='rounded border px-3 py-2 text-sm disabled:opacity-40';
  return <section className="space-y-3 rounded-lg border bg-white p-4" aria-label="ZAICO暫定双方向同期">
    <h3 className="font-semibold">ZAICOとの暫定同期</h3>
    <p className="text-sm">初回はZAICOの情報を基準にそろえます。その後は変更した項目だけを同期し、同じ項目の競合はZAICOを優先します。</p>
    <p role="status" className="font-medium">{status?labels[control?.phase??'DISABLED']:'状態を確認中…'}</p>
    {control?.work&&<p className="text-sm">{control.work.index.toLocaleString()}件を処理済み</p>}
    {control?.initialCompletedAt&&<p className="text-sm">初回同期完了：{new Date(control.initialCompletedAt).toLocaleString('ja-JP')}</p>}
    {control?.lastSuccessfulPullAt&&<p className="text-sm">差分取得の基準：{new Date(control.lastSuccessfulPullAt).toLocaleString('ja-JP')}</p>}
    {control?.summary&&<p className="text-sm">未反映 {control.summary.pending??0} 件 ／ エラー {control.summary.errors??0} 件 ／ 要確認 {control.summary.conflicts??0} 件</p>}
    {!!status?.rawCount&&<p className="text-sm text-amber-800">数値・日付に変換できない元の値を {status.rawCount} 商品に保持しています。商品詳細の「ZAICOの元の値」で確認できます。</p>}
    {control?.lastError&&<p role="alert" className="text-sm text-red-700">{control.lastError}</p>}
    {message&&<p role="status" className="text-sm">{message}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {status&&!control&&<button className={button} disabled={busy} onClick={()=>{if(confirm('変更前のBELLOデータをバックアップし、初回はZAICOを基準に同期します。開始しますか？'))void act({operation:'START',confirmed:true});}}>ZAICOを基準に開始</button>}
      {control&&control.phase!=='STOPPED'&&<>
        <label className="text-sm">取得間隔 <input aria-label="ZAICO取得間隔（分）" className="w-20 rounded border p-2" type="number" min="1" max="1440" value={minutes} onChange={e=>setMinutes(e.target.value)}/> 分</label>
        <button className={button} disabled={busy} onClick={()=>void act({operation:'INTERVAL',minutes:Number(minutes)})}>間隔を保存</button>
        <button className={button} disabled={busy} onClick={()=>void act({operation:'POLL'})}>同期を予約</button>
        {control.phase==='ACTIVE'&&<button className={button} disabled={busy} onClick={()=>void act({operation:'FINAL_CHECK'})}>完全移行に向けて最終照合</button>}
        {control.phase==='FINALIZING'&&<button className={button} disabled={busy||!control.finalCheck||control.finalCheck.pending>0||control.finalCheck.errors>0||control.finalCheck.conflicts>0}
          onClick={()=>{if(confirm('最終照合の結果を確認しましたか？ ZAICOへの送信・取得を両方停止し、BELLOだけで運用します。'))void act({operation:'STOP',confirmed:true});}}>確認して連携を終了</button>}
      </>}
      <button className={button} disabled={busy} onClick={()=>void load()}>状態を更新</button>
    </div>
    {status?.issues.map(issue=><details key={issue.id} className="rounded border p-2 text-sm"><summary>{issue.sourceId?`ZAICO ${issue.sourceId}`:issue.id}：{issue.error??'競合した編集を保持しています'}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(issue.conflict??{},null,2)}</pre>
      {issue.conflict&&<button className={button} disabled={busy} onClick={()=>{if(confirm('ZAICOを優先した内容と、保持されたBELLOの値を確認しましたか？'))void act({operation:'ACKNOWLEDGE',inventoryId:issue.id,confirmed:true});}}>競合内容を確認済みにする</button>}
    </details>)}
  </section>;
}

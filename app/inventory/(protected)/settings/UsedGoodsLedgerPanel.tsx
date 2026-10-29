"use client";
import {useEffect,useRef,useState} from 'react';
import type {UsedGoodsLedger} from '@/lib/inventory/usedGoodsLedger';

export function UsedGoodsLedgerPanel() {
  const [year,setYear]=useState(new Date(Date.now()+9*3600000).getUTCFullYear());
  const [ledger,setLedger]=useState<UsedGoodsLedger|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [page,setPage]=useState(0),[view,setView]=useState<'summary'|'rows'|'issues'>('summary');
  const [direction,setDirection]=useState('受入れ');
  const controller=useRef<AbortController|null>(null);
  const urls=useRef(new Set<string>());
  useEffect(()=>()=>{controller.current?.abort();for(const url of urls.current)URL.revokeObjectURL(url);},[]);
  async function load(download=false) {
    if(busy)return;
    setError('');setBusy(download?'Excelを作成しています…':'在庫から台帳を作成しています…');
    const c=new AbortController();controller.current=c;
    try{
      const response=await fetch(`/api/inventory/used-goods-ledger?year=${year}${download?'&format=xlsx':''}`,{cache:'no-store',signal:c.signal});
      if(!response.ok){const result=await response.json();throw Error(result.error||'台帳を取得できませんでした。');}
      if(download){
        const blob=await response.blob();if(c.signal.aborted)return;
        const url=URL.createObjectURL(blob);urls.current.add(url);
        const a=document.createElement('a');a.href=url;a.download=`BELLO_古物台帳_${year}年.xlsx`;document.body.appendChild(a);a.click();a.remove();
        window.setTimeout(()=>{URL.revokeObjectURL(url);urls.current.delete(url);},30000);
      }else{setLedger(await response.json());setPage(0);}
    }catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'台帳を取得できませんでした。');}
    finally{if(!c.signal.aborted)setBusy('');}
  }
  const visibleRows=ledger?.rows.filter(r=>r.direction===direction)??[];
  const list=ledger?(view==='summary'?ledger.supplierDays:view==='rows'?visibleRows:ledger.issues):[];
  const pages=Math.max(1,Math.ceil(list.length/50));
  return <section className="space-y-5" aria-label="古物台帳">
    <div><h2 className="text-lg font-bold text-gray-900">古物台帳</h2><p className="mt-1 text-sm text-gray-600">在庫に登録した取引情報を年ごとにまとめます。商品情報は変更しません。</p></div>
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <label className="text-sm font-medium">対象年<input aria-label="対象年" type="number" min={1900} max={2100} value={year} disabled={!!busy} onChange={e=>{setYear(Number(e.target.value));setLedger(null);setPage(0);}} className="mt-1 block w-28 rounded border border-gray-300 bg-white px-3 py-2.5" /></label>
      <button type="button" disabled={!!busy||year<1900||year>2100} onClick={()=>load()} className="rounded border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold disabled:opacity-50">帳簿を表示</button>
      <button type="button" disabled={!!busy||year<1900||year>2100} onClick={()=>load(true)} className="rounded bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Excelをダウンロード</button>
      {busy&&<p role="status" className="text-sm text-gray-600">{busy}</p>}
    </div>
    {error&&<p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="space-y-1 text-sm text-gray-600">
      <p>受入れは「取引の年月日」、払出しは「販売終了日」が対象年に入る記録を出力します。</p>
      <p>同じ日・同じ仕入先を1行にまとめ、合計金額を表示します。登録済みの日次合計は重複して加算しません。</p>
      <p>商品ごとの品目・特徴は「商品別明細」に残します。数量分割したページは仕入れを重複計上しません。</p>
      <p>未記録の情報は空欄です。「確認事項」には不足項目と、取引日が未登録の記録（全期間）を表示します。</p>
    </div>
    {ledger&&<>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <strong>{ledger.year}年　{ledger.rows.length.toLocaleString()}件</strong>
        <span>受入れ {ledger.rows.filter(r=>r.direction==='受入れ').length.toLocaleString()}件 ／ 払出し {ledger.rows.filter(r=>r.direction==='払出し').length.toLocaleString()}件</span>
        <span className="text-gray-500">分割先の仕入れ重複 {ledger.omittedSplits}件を除外</span>
      </div>
      <div className="flex gap-2 border-b border-gray-200">
        {(['summary','rows','issues'] as const).map(tab=><button key={tab} type="button" onClick={()=>{setView(tab);setPage(0);}} aria-pressed={view===tab} className={`px-4 py-3 text-sm ${view===tab?'border-b-2 border-gray-900 font-bold':'text-gray-500'}`}>{tab==='summary'?'日付・仕入先別':tab==='rows'?'商品別明細':`確認事項（${ledger.issues.length}件）`}</button>)}
      </div>
      {view==='rows'&&<label className="flex items-center gap-3 text-sm">表示する記録<select aria-label="表示する記録" value={direction} onChange={e=>{setDirection(e.target.value);setPage(0);}} className="rounded border border-gray-300 bg-white px-3 py-2"><option value="受入れ">受入れ（仕入れ）</option><option value="払出し">払出し（売却）</option></select></label>}
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-gray-200">
        {view==='summary'&&<table className="w-full min-w-[1000px] text-left text-sm"><thead className="sticky top-0 bg-gray-100"><tr>{['取引日','仕入先','品目・数量','仕入れ合計','内訳','確認事項'].map(h=><th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{ledger.supplierDays.slice(page*50,(page+1)*50).map(g=><tr key={g.key} className="border-t align-top"><td className="whitespace-nowrap p-3">{g.date}</td><td className="min-w-44 p-3"><strong>{g.counterpartyName||'未記録'}</strong><p className="mt-1 whitespace-pre-wrap text-gray-500">{g.counterpartyAddress}</p></td><td className="min-w-40 whitespace-pre-wrap p-3">{g.itemTypes||'品目未記録'}<p className="mt-1 font-semibold">{g.quantity===null?'数量要確認':`${g.quantity}点`}</p></td><td className="min-w-40 p-3"><strong>{g.total===null?'合計要確認':`${g.total.toLocaleString()}円`}</strong><p className="mt-1 text-xs text-gray-500">{g.amountBasis}</p></td><td className="p-3"><span>{g.products}商品</span><p className="mt-1 max-w-44 whitespace-pre-wrap text-xs text-gray-500">{g.references}</p></td><td className="min-w-52 max-w-72 whitespace-pre-wrap p-3 text-amber-800">{g.issues.join('\n')||'—'}</td></tr>)}</tbody></table>}
        {view==='rows'&&<table className="w-full min-w-[1150px] text-left text-sm">
          <thead className="sticky top-0 bg-gray-100"><tr>{['取引日','区分','管理番号・商品名','品目・数量','特徴','相手方・住所','本人確認・年齢','確認事項'].map(h=><th key={h} className="px-3 py-3 font-semibold">{h}</th>)}</tr></thead>
          <tbody>{visibleRows.slice(page*50,(page+1)*50).map((r,i)=><tr key={`${r.inventoryId}:${r.direction}:${i}`} className="border-t border-gray-100 align-top">
            <td className="whitespace-nowrap p-3">{r.date}</td><td className="whitespace-nowrap p-3">{r.direction}<br/>{r.transactionType||'未記録'}</td>
            <td className="min-w-60 max-w-80 p-3"><a className="font-semibold text-blue-700 underline" href={`/inventory/${encodeURIComponent(r.inventoryId)}`} target="_blank" rel="noreferrer">{r.managementNumber}</a><p className="mt-1 break-words">{r.name}</p></td>
            <td className="min-w-32 p-3">{r.itemType||'未記録'}<p className="mt-1 font-semibold">{r.quantity===null?'数量未記録':`${r.quantity}点`}</p></td>
            <td className="min-w-40 max-w-60 whitespace-pre-wrap p-3">{r.feature||'未記録'}</td>
            <td className="min-w-44 max-w-64 p-3">{r.counterpartyName||'未記録'}<p className="mt-1 text-gray-500">{r.counterpartyAddress}</p><p>{r.counterpartyOccupation}</p></td>
            <td className="min-w-44 max-w-64 p-3">{r.verification}<p className="mt-1">{r.counterpartyAge||'年齢・生年月日未記録'}</p></td>
            <td className="min-w-52 max-w-80 p-3 text-amber-800">{r.issues.join('／')||'—'}</td>
          </tr>)}</tbody>
        </table>}
        {view==='issues'&&<table className="w-full min-w-[700px] text-left text-sm"><thead className="sticky top-0 bg-gray-100"><tr>{['管理番号','商品名','記録日','確認内容'].map(h=><th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{ledger.issues.slice(page*50,(page+1)*50).map((r,i)=><tr key={i} className="border-t border-gray-100 align-top"><td className="p-3">{r.inventoryId?<a href={`/inventory/${encodeURIComponent(r.inventoryId)}`} target="_blank" rel="noreferrer" className="text-blue-700 underline">{r.managementNumber}</a>:r.managementNumber}</td><td className="max-w-72 p-3">{r.name}</td><td className="whitespace-nowrap p-3">{r.date||'未登録'}</td><td className="max-w-xl p-3">{r.message}</td></tr>)}</tbody></table>}
        {!list.length&&<p className="p-6 text-center text-sm text-gray-500">該当する記録はありません。</p>}
      </div>
      <div className="flex items-center justify-between text-sm"><span>{list.length?`${page*50+1}〜${Math.min((page+1)*50,list.length)} / ${list.length}件`:'0件'}</span><div className="flex items-center gap-3"><button type="button" disabled={page===0} onClick={()=>setPage(p=>p-1)} className="rounded border px-4 py-2 disabled:opacity-40">前へ</button><span>{page+1} / {pages}</span><button type="button" disabled={page+1>=pages} onClick={()=>setPage(p=>p+1)} className="rounded border px-4 py-2 disabled:opacity-40">次へ</button></div></div>
    </>}
    <p className="text-xs leading-5 text-gray-500">保存済みの在庫情報から作成する帳簿です。過去に完全削除された記録は復元できません。記録の要否・不足項目を確認し、出力した帳簿を保管してください。<a href="https://www.keishicho.metro.tokyo.lg.jp/tetsuzuki/kobutsu/youshiki/chobo_yoshiki.html" target="_blank" rel="noreferrer" className="ml-1 underline">帳簿の様式（警視庁）</a></p>
  </section>;
}

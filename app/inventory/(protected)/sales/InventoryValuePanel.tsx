import type {ReactNode} from 'react';
import {donutSegments,type InventoryValue,type InventoryValueView} from '../../../../lib/inventory/inventoryValue';
import {inventoryMonthOptions} from '../../../../lib/inventory/inventoryValueCalendar';
import {formatJstDateTime} from '../../../../lib/inventory/sales';

const yen=(n:number)=>'¥'+n.toLocaleString('ja-JP');
function Breakdown({value:v,metric}:{value:InventoryValue;metric:'amount'|'quantity'}) {
  const amount=metric==='amount',total=amount?v.total:v.quantity;
  const unknown=amount && v.count>0 && v.unpricedCount>=v.count;
  const title=amount?'作業状況別の在庫金額':'作業状況別の在庫数量';
  const display=(n:number)=>amount?yen(n):n.toLocaleString('ja-JP')+'点';
  return <section aria-label={title} className="rounded-2xl border border-slate-200 bg-white px-4 py-5 sm:px-10 sm:py-7">
    <h3 className="text-lg font-semibold">{title}</h3>
    <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[minmax(0,0.85fr)_1.4fr] md:gap-12">
      <svg viewBox="0 0 120 120" role="img" aria-label={title+'・円グラフ'} className="mx-auto w-full max-w-80">
        <circle cx="60" cy="60" r="45" fill="none" stroke="#eef1ef" strokeWidth="16"/>
        {donutSegments(v.groups,metric).map(g=><circle key={g.key} cx="60" cy="60" r="45" pathLength="100" fill="none" stroke={g.color} strokeWidth="16" strokeDasharray={`${g.length} ${100-g.length}`} strokeDashoffset={-g.offset} transform="rotate(-90 60 60)"><title>{g.label} {display(g[metric])} {g.length.toFixed(1)}%</title></circle>)}
        <text x="60" y="56" textAnchor="middle" fill="#66736d" fontSize="5">{amount?'在庫金額':'在庫数量'}</text>
        <text x="60" y="68" textAnchor="middle" fill="#264e47" fontSize={amount?8:11} fontWeight="600">{unknown ? '—' : display(total)}</text>
      </svg>
      <dl>{v.groups.map(g=><div key={g.key} className="flex items-center gap-3 border-b border-slate-100 py-4 last:border-0">
        <span aria-hidden="true" style={{backgroundColor:g.color}} className="h-3 w-3 shrink-0 rounded-full"/>
        <dt className="flex-1 font-medium">{g.label}{amount&&<span className="mt-1 block text-xs font-normal text-slate-500">{g.quantity.toLocaleString()}点</span>}</dt>
        <dd className="text-right"><span className="block text-xl font-semibold tabular-nums">{unknown ? '—' : display(g[metric])}</span><span className="mt-1 block text-xs text-slate-500 tabular-nums">{unknown ? '—' : (total>0?(g[metric]/total*100).toFixed(1):'0.0')+'%'}</span></dd>
      </div>)}</dl>
    </div>
  </section>;
}
export function InventoryValuePicker({month,query,action='/inventory/sales'}:{month?:string;query?:Record<string,string>;action?:string}) {
  const hidden = ['view','month','dimension','slice','sliceLabel','generation','detailStart','detailEnd','detailTarget'];
  return <form className="flex flex-wrap items-center gap-2" action={action}>
    <input type="hidden" name="view" value="inventory"/>
    {Object.entries(query??{}).filter(([key])=>!hidden.includes(key)).map(([key,value])=><input key={key} type="hidden" name={key} value={value}/>)}
    <label htmlFor="inventory-month" className="text-sm font-medium">集計時点</label>
    <select id="inventory-month" name="month" defaultValue={month??''} className="rounded-lg border bg-white px-4 py-3">
      <option value="">現在の在庫</option>
      {inventoryMonthOptions().map(m=><option key={m} value={m}>{m.replace('-','年')}月末</option>)}
    </select>
    <button type="submit" className="rounded-lg bg-teal-800 px-5 py-3 text-sm font-bold text-white">表示</button>
  </form>;
}

export function InventoryValueReport({view,analysis}:{view:InventoryValueView;analysis?:ReactNode}) {
  if(view.status!=='ok') return <div role="status" className="rounded-xl border p-6">
    <h2 className="text-lg font-bold">在庫金額</h2>
    <p className="mt-3">{view.status==='missing'?'在庫金額はまだ集計されていません。':'在庫金額を取得できませんでした。再読み込みしてください。'}</p>
  </div>;
  const v=view.value;
  return <div className="max-w-6xl space-y-5 text-slate-800">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-sm text-slate-500">{v.month?v.month.replace('-','年')+'月末の在庫金額':'集計時点の在庫金額'}</p>
        <h2 className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-teal-900">{v.count > 0 && v.unpricedCount >= v.count ? '—' : yen(v.total)}</h2>
        <p className="mt-2 text-sm text-slate-500">在庫数量 {v.quantity.toLocaleString()}点</p></div>
      <p className="text-right text-xs leading-6 text-slate-500">{formatJstDateTime(v.asOf)} 時点<br/>{v.month?'月末の記録':'12時間ごとに自動集計'}</p>
    </div>
    {analysis}
    <Breakdown value={v} metric="amount"/>
    <Breakdown value={v} metric="quantity"/>
    {v.unpricedCount>0&&<details className="text-xs leading-6 text-slate-600">
      <summary className="cursor-pointer">在庫金額の集計について</summary>
      <p>購入単価を確認できない在庫記録 {v.unpricedCount.toLocaleString('ja-JP')}件は数量のみ計上しています。</p>
    </details>}
  </div>;
}

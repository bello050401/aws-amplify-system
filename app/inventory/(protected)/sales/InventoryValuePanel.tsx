import Link from 'next/link';
import {donutSegments,type InventoryValue,type InventoryValueView} from '@/lib/inventory/inventoryValue';
import {inventoryMonthOptions} from '@/lib/inventory/inventoryValueCalendar';
import {formatJstDateTime} from '@/lib/inventory/sales';

const yen=(n:number)=>'¥'+n.toLocaleString('ja-JP');
export function SalesViewTabs({inventory=false}:{inventory?:boolean}) {
  return <nav aria-label="売上・在庫金額の切り替え" className="mb-6 flex w-fit rounded-xl bg-slate-100 p-1">
    {[['売上','/inventory/sales',!inventory],['在庫金額','/inventory/sales?view=inventory',inventory]].map(([label,href,active])=><Link key={String(label)} href={String(href)} aria-current={active?'page':undefined} className={`min-w-36 rounded-lg px-6 py-3 text-center text-sm font-bold ${active?'bg-white text-teal-900 shadow-sm':'text-slate-500 hover:text-slate-800'}`}>{label}</Link>)}
  </nav>;
}
function Breakdown({value:v,metric}:{value:InventoryValue;metric:'amount'|'quantity'}) {
  const amount=metric==='amount',total=amount?v.total:v.quantity;
  const title=amount?'在庫金額の割合':'在庫数量の割合';
  const display=(n:number)=>amount?yen(n):n.toLocaleString('ja-JP')+'点';
  return <section aria-label={title} className="rounded-2xl border border-slate-200 bg-white px-10 py-7">
    <h3 className="text-lg font-semibold">{title}</h3>
    <div className="grid grid-cols-[minmax(260px,0.85fr)_1.4fr] items-center gap-12">
      <svg viewBox="0 0 120 120" role="img" aria-label={title+'・カテゴリ別円グラフ'} className="mx-auto w-full max-w-80">
        <circle cx="60" cy="60" r="45" fill="none" stroke="#eef1ef" strokeWidth="16"/>
        {donutSegments(v.groups,metric).map(g=><circle key={g.key} cx="60" cy="60" r="45" pathLength="100" fill="none" stroke={g.color} strokeWidth="16" strokeDasharray={`${g.length} ${100-g.length}`} strokeDashoffset={-g.offset} transform="rotate(-90 60 60)"><title>{g.label} {display(g[metric])} {g.length.toFixed(1)}%</title></circle>)}
        <text x="60" y="56" textAnchor="middle" fill="#66736d" fontSize="5">{amount?'在庫金額':'在庫数量'}</text>
        <text x="60" y="68" textAnchor="middle" fill="#264e47" fontSize={amount?8:11} fontWeight="600">{display(total)}</text>
      </svg>
      <dl>{v.groups.map(g=><div key={g.key} className="flex items-center gap-3 border-b border-slate-100 py-4 last:border-0">
        <span aria-hidden="true" style={{backgroundColor:g.color}} className="h-3 w-3 shrink-0 rounded-full"/>
        <dt className="flex-1 font-medium">{g.label}{amount&&<span className="mt-1 block text-xs font-normal text-slate-500">{g.quantity.toLocaleString()}点</span>}</dt>
        <dd className="text-right"><span className="block text-xl font-semibold tabular-nums">{display(g[metric])}</span><span className="mt-1 block text-xs text-slate-500 tabular-nums">{total>0?(g[metric]/total*100).toFixed(1):'0.0'}%</span></dd>
      </div>)}</dl>
    </div>
  </section>;
}
export function InventoryValuePanel({view,month}:{view:InventoryValueView;month?:string}) {
  const picker=<form className="flex items-center gap-3" action="/inventory/sales"><input type="hidden" name="view" value="inventory"/><label htmlFor="inventory-month" className="text-sm font-medium">集計時点</label><select id="inventory-month" name="month" defaultValue={month??''} className="rounded-lg border bg-white px-4 py-3"><option value="">現在の在庫</option>{inventoryMonthOptions().map(m=><option key={m} value={m}>{m.replace('-','年')}月末</option>)}</select><button type="submit" className="rounded-lg bg-teal-800 px-5 py-3 text-sm font-bold text-white">表示</button></form>;
  if(view.status!=='ok') return <div className="space-y-6">{picker}<div role="status" className="rounded-xl border p-8"><h2 className="text-lg font-bold">在庫金額</h2><p className="mt-3">{view.status==='missing'?'在庫金額はまだ集計されていません。':'在庫金額を取得できませんでした。再読み込みしてください。'}</p><p className="mt-2 text-sm text-slate-500">在庫が0円という意味ではありません。</p></div></div>;
  const v=view.value;
  return <div className="max-w-6xl space-y-6 text-slate-800">
    {picker}
    <div className="flex items-end justify-between gap-6"><div><p className="text-sm text-slate-500">{v.month?v.month.replace('-','年')+'月末の在庫金額':'集計時点の在庫金額'}</p><h2 className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{yen(v.total)}</h2><p className="mt-2 text-sm text-slate-500">在庫数量 {v.quantity.toLocaleString()}点</p></div><p className="text-right text-xs leading-6 text-slate-500">{formatJstDateTime(v.asOf)} 時点<br/>{v.month?'月末の記録':'12時間ごとに自動集計'}</p></div>
    <Breakdown value={v} metric="amount"/>
    <Breakdown value={v} metric="quantity"/>
    {v.unpricedCount>0&&<p className="text-xs leading-6 text-slate-500">購入単価を確認できない{v.unpricedCount}商品は金額に含めず、数量のみ計上しています。</p>}
  </div>;
}

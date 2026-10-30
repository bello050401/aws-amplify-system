'use client';
import Link from 'next/link';
import {completeRestageDraft,RESTAGE_ITEM_TYPES,type RestageDraft} from '@/lib/procurement/restageDraft';

export type RestageRow=RestageDraft&{inventoryId:string|null;needsUpdate?:boolean;deleted?:boolean;state?:'pending'|'working'|'done'|'skipped'|'failed';error?:string};
export function rowProblem(row:RestageDraft){try{completeRestageDraft(row);return '';}catch(e){return(e as Error).message;}}
const money=(value:number|null)=>value===null?'未入力':`${value.toLocaleString()}円`;
export default function RestageReview({rows,busy,onChange}:{rows:RestageRow[];busy:boolean;onChange:(id:string,values:Partial<RestageRow>)=>void}){
  return <div className="space-y-3">{rows.map(row=>{
    const problem=rowProblem(row),locked=busy||!!row.inventoryId;
    const price=problem?null:completeRestageDraft(row).purchasePrice;
    const field='min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base disabled:bg-gray-100';
    return <article key={row.goodsId} className={`rounded-xl border bg-white p-4 sm:p-5 ${problem?'border-amber-400':'border-gray-200'}`} aria-label={`商品 ${row.goodsId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="mb-1 text-xs text-gray-500">商品ID {row.goodsId} · 出品番号 {row.lotNumber}</p><h3 className="break-words font-semibold text-gray-900">{row.name}</h3></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${problem?'bg-amber-100 text-amber-900':row.inventoryId?'bg-green-50 text-green-800':'bg-blue-50 text-blue-800'}`}>{row.state==='working'?'登録中':row.inventoryId?'登録済み':problem?'入力が必要':'登録できます'}</span></div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><div><span className="text-gray-500">数量</span><p className="font-semibold">{row.quantity===null?'未入力':`${row.quantity}${row.unit}`}</p></div><div><span className="text-gray-500">落札価格{row.isBundle?'（一山合計）':'（1点）'}</span><p>{money(row.hammerPrice)}</p></div><div><span className="text-gray-500">購入単価</span><p className="font-semibold">{price===null?'入力後に自動計算':money(price)}</p></div><div><span className="text-gray-500">品目</span><p>{row.itemType}</p></div></div>
      {problem&&<p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{problem} 読み取れた情報は保持しています。</p>}
      {!!row.issues.length&&<p className="mt-2 text-xs text-gray-500">取得時の確認事項：{row.issues.join(' ')} ／ 元の表示数量：{row.sourceQuantity}</p>}
      {!row.inventoryId&&<details className="mt-3 border-t pt-3" open={row.issues.length?true:undefined}><summary className="cursor-pointer py-1 text-sm font-medium text-blue-700">取得内容を確認・編集</summary><fieldset disabled={locked} className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1 text-sm sm:col-span-2 lg:col-span-3"><span>商品名</span><input aria-label={`商品名 ${row.goodsId}`} maxLength={1000} value={row.name} onChange={e=>onChange(row.goodsId,{name:e.target.value})} className={field}/></label>
        <label className="space-y-1 text-sm"><span>数量</span><input aria-label={`数量 ${row.goodsId}`} type="number" inputMode="numeric" min={1} max={100000} step={1} placeholder="数量を入力" value={row.quantity??''} onChange={e=>onChange(row.goodsId,{quantity:e.target.value===''?null:Number(e.target.value)})} className={field}/></label>
        <label className="space-y-1 text-sm"><span>単位</span><select aria-label={`単位 ${row.goodsId}`} value={row.unit} onChange={e=>onChange(row.goodsId,{unit:e.target.value})} className={field}>{['点','脚','台','個','枚','本','組','セット','式'].map(u=><option key={u}>{u}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>品目</span><select aria-label={`品目 ${row.goodsId}`} value={row.itemType} onChange={e=>onChange(row.goodsId,{itemType:e.target.value})} className={field}>{RESTAGE_ITEM_TYPES.map(t=><option key={t}>{t}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>落札価格（円）</span><input aria-label={`落札価格 ${row.goodsId}`} type="number" inputMode="numeric" min={1} max={100000000} step={1} value={row.hammerPrice??''} onChange={e=>onChange(row.goodsId,{hammerPrice:e.target.value===''?null:Number(e.target.value)})} className={field}/></label>
        <label className="space-y-1 text-sm sm:col-span-2"><span>落札価格の扱い</span><select aria-label={`落札価格の扱い ${row.goodsId}`} value={row.isBundle?'bundle':'single'} onChange={e=>onChange(row.goodsId,{isBundle:e.target.value==='bundle'})} className={field}><option value="single">通常商品：1点あたりの落札価格</option><option value="bundle">一山商品：全点分の落札合計金額</option></select></label>
      </fieldset><p className="mt-3 text-sm text-gray-500">{row.isBundle?'落札価格 × 1.188 ÷ 数量':'落札価格 × 1.188'} → 購入単価 {price===null?'入力後に計算':money(price)}（1円未満四捨五入）</p></details>}
      {row.error&&<p role="alert" className="mt-3 text-sm text-red-700">{row.error}</p>}
      {row.inventoryId&&<p className="mt-3 text-sm text-green-800">{row.needsUpdate?'台帳・初期値を更新予定':row.deleted?'登録済み（商品削除済み）':'登録済み・重複作成しません'} {!row.deleted&&<Link href={'/inventory/'+row.inventoryId} className="ml-2 text-blue-700 underline">商品ページ</Link>}</p>}
    </article>;
  })}</div>;
}

"use client";
import {useState} from 'react';
import {useInventoryView} from '../../useInventoryView';
import {useInventoryListDensity} from '../../useInventoryListDensity';
import {orderedVisibleOptions} from '@/lib/inventory/viewPreferences';
import type {MasterOption} from '@/lib/inventory/queries';

export function InventoryViewSettings({categories,locations}:{categories:Pick<MasterOption,"id"|"name">[];locations:Pick<MasterOption,"id"|"name">[]}){
 const {view,change,ready,error}=useInventoryView(),{density,setDensity}=useInventoryListDensity();
 return <div className="space-y-6 text-sm">
  <p className="text-gray-500">表示設定はアカウントに保存され、別端末で開いたときも引き継がれます。商品のカテゴリ・数量・保管場所は変更されません。</p>
  <fieldset disabled={!ready} className="space-y-4 rounded-lg border p-4"><legend className="px-2 font-semibold">一覧の見え方と操作</legend>
   <label className="flex items-center justify-between gap-4">行の高さ<select aria-label="設定：行の高さ" value={density} onChange={e=>setDensity(e.target.value as 'normal'|'compact')} className="rounded border p-2"><option value="normal">標準（商品名を全文表示）</option><option value="compact">コンパクト</option></select></label>
   <label className="flex items-center justify-between gap-4">カテゴリの表示位置<select aria-label="カテゴリの表示位置" value={view.categoryPlacement} onChange={e=>change({categoryPlacement:e.target.value as 'name'|'column'})} className="rounded border p-2"><option value="column">独立した列</option><option value="name">物品名の上</option></select></label>
   <label className="flex gap-3"><input type="checkbox" checked={view.pinFirstColumn} onChange={e=>change({pinFirstColumn:e.target.checked})}/>横スクロール中も先頭の表示列を固定する</label>
   <label className="flex gap-3"><input type="checkbox" checked={view.keepSelection} onChange={e=>change({keepSelection:e.target.checked})}/>詳細画面から戻っても選択を維持する</label>
   <p className="text-xs text-gray-500">検索条件を変えたときは、誤操作を防ぐため選択を解除します。</p>
  </fieldset>
  <OptionSettings title="サイドバーのカテゴリ" items={categories} order={view.categoryOrder} hidden={view.hiddenCategories} onChange={(order,hidden)=>change({categoryOrder:order,hiddenCategories:hidden})}/>
  <OptionSettings title="サイドバーの保管場所" items={locations} order={view.locationOrder} hidden={view.hiddenLocations} onChange={(order,hidden)=>change({locationOrder:order,hiddenLocations:hidden})}/>
  {error&&<p role="alert" className="text-red-700">{error}</p>}
 </div>;
}
function OptionSettings({title,items,order,hidden,onChange}:{title:string;items:Pick<MasterOption,"id"|"name">[];order:string[];hidden:string[];onChange:(o:string[],h:string[])=>void}){
 const [query,setQuery]=useState('');const sorted=orderedVisibleOptions(items,order,[]);
 function move(id:string,step:number){const ids=sorted.map(v=>v.id),i=ids.indexOf(id),j=i+step;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];onChange(ids,hidden);}
 return <details className="rounded-lg border p-4"><summary className="cursor-pointer font-semibold">{title} <span className="font-normal text-gray-500">表示・順序</span></summary>
  <p className="my-3 text-xs text-gray-500">よく使うものを上に移動できます。非表示にしても、詳細検索や編集時にはすべて選択できます。絞り込み中の項目は表示を維持します。</p>
  <input type="search" aria-label={title+'の候補検索'} placeholder="名前で探す" value={query} onChange={e=>setQuery(e.target.value)} className="mb-2 w-full rounded border p-2"/>
  <div className="max-h-72 overflow-auto divide-y">{sorted.filter(v=>v.name.includes(query)).map(v=><div key={v.id} className="flex items-center gap-2 py-2">
   <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={!hidden.includes(v.id)} onChange={e=>onChange(order,e.target.checked?hidden.filter(id=>id!==v.id):[...hidden,v.id])}/><span className="break-words">{v.name}</span></label>
   <button type="button" aria-label={title+'：'+v.name+'を上へ'} disabled={sorted[0]?.id===v.id} onClick={()=>move(v.id,-1)} className="h-9 w-9 rounded border disabled:opacity-30">↑</button>
   <button type="button" aria-label={title+'：'+v.name+'を下へ'} disabled={sorted.at(-1)?.id===v.id} onClick={()=>move(v.id,1)} className="h-9 w-9 rounded border disabled:opacity-30">↓</button>
  </div>)}</div><button type="button" className="mt-3 underline" onClick={()=>onChange([],[])}>表示と順序を初期設定に戻す</button>
 </details>;
}

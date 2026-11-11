"use client";
import {useState} from 'react';
import {INLINE_EDIT_FIELDS,type StaticInlineEditFieldKey} from '@/lib/inventory/inlineEdit';
import type {InventoryEditRules} from '@/lib/inventory/editTransform';
import {inventoryFieldLabel} from '@/lib/inventory/fieldLabel';
import {ALL_EXTENDED_FIELDS} from '@/lib/inventory/extendedFields';
type Fields=NonNullable<InventoryEditRules['fields']>;
const keys=Object.keys(INLINE_EDIT_FIELDS).filter(k=>!['name','category','location'].includes(k)) as (keyof Fields)[];
export function BulkScalarFields({fields,onChange}:{fields:Fields;onChange:(v:Fields)=>void}){
 const [query,setQuery]=useState('');
 function update(key:keyof Fields,value:string|number|null|undefined){const next={...fields};if(value===undefined)delete next[key];else Object.assign(next,{[key]:value});onChange(next);}
 const input='w-full rounded-lg border border-gray-300 bg-white p-2 text-sm';
 return <details className="space-y-4 rounded-xl border bg-white p-5"><summary className="cursor-pointer font-semibold">数量・価格・備考・サイズなど <span className="ml-2 text-sm font-normal text-gray-500">{Object.keys(fields).length}項目を変更</span></summary>
  <p className="text-sm text-gray-500">「値を指定する」を選んだ項目だけ変更します。数量は各商品の現在数を指定値に置き換えます。</p>
  <input type="search" aria-label="一括編集する項目を検索" placeholder="項目名で探す" className={input} value={query} onChange={e=>setQuery(e.target.value)}/>
  {keys.filter(k=>inventoryFieldLabel(k).includes(query)).map(key=>{
   const label=inventoryFieldLabel(key),value=fields[key],type=INLINE_EDIT_FIELDS[key as StaticInlineEditFieldKey].inputType,def=ALL_EXTENDED_FIELDS.find(d=>d.key===key);
   const mode=Object.hasOwn(fields,key)?value===null?'clear':'set':'keep';
   return <div key={key} className="grid gap-2 border-t pt-3 md:grid-cols-[150px_1fr]">
    <label htmlFor={'bulk-field-'+key} className="py-2 font-medium">{label}</label><div className="space-y-2">
     <select id={'bulk-field-'+key} aria-label={label+'の一括操作'} value={mode} className={input} onChange={e=>update(key,e.target.value==='keep'?undefined:e.target.value==='clear'?null:'')}><option value="keep">変更しない</option><option value="set">値を指定する</option><option value="clear">空欄にする</option></select>
     {mode==='set'&&(def?.type==='select'?<select aria-label={label+'の指定値'} className={input} value={String(value??'')} onChange={e=>update(key,e.target.value)}><option value="">選択してください</option>{def.options?.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:type==='textarea'?<textarea aria-label={label+'の指定値'} rows={3} className={input} value={String(value??'')} onChange={e=>update(key,e.target.value)}/>:<input aria-label={label+'の指定値'} className={input} type={type==='number'?'number':type==='date'?'date':'text'} step="any" min={type==='number'?0:undefined} value={value??''} onChange={e=>update(key,type==='number'&&e.target.value!==''?Number(e.target.value):e.target.value)}/>)}
     {mode==='clear'&&<p className="text-xs text-amber-800">選択した商品の「{label}」を空欄にします。</p>}
    </div>
   </div>;
  })}
 </details>;
}

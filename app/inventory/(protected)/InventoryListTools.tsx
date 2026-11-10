"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CustomFieldDefinitionRow, MasterOption } from "@/lib/inventory/queries";
import { INVENTORY_SORT_OPTIONS, parseInventoryListSort } from "@/lib/inventory/searchSort";
import { buildListReturnQuery } from "@/lib/inventory/listReturnParams";
import { listFilterHref } from "@/lib/inventory/listFilterNavigation";
import { useUnsavedChanges } from "../UnsavedChangesProvider";
import { ListColumnSettings } from "./settings/ListColumnSettings";
import {useInventoryListDensity} from "../useInventoryListDensity";

const key = "bello-inventory-saved-searches-v1";
type Saved = {id:string;name:string;query:string};
const button = "rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50";
export function InventoryListTools({customFieldDefs,categories,locations}:{
  customFieldDefs:CustomFieldDefinitionRow[];categories:MasterOption[];locations:MasterOption[];
}) {
  const params=useSearchParams(),router=useRouter();
  const {density,setDensity}=useInventoryListDensity();
  const {isDirty,guardedNavigate}=useUnsavedChanges();
  const [open,setOpen]=useState<"columns"|"saved"|null>(null),[saved,setSaved]=useState<Saved[]>([]);
  const [name,setName]=useState(""),[error,setError]=useState("");
  const [editing,setEditing]=useState<{id:string;name:string}|null>(null);
  const [overwriteId,setOverwriteId]=useState<string|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const sort=parseInventoryListSort(params.get("sort")??undefined,params.get("direction")??undefined);
  const categoryIds=(params.get("categoryIds")??"").split(",").filter(Boolean);
  useEffect(()=>{try {
    const value=JSON.parse(localStorage.getItem(key)??"[]");
    if(Array.isArray(value))setSaved(value.filter(v=>v&&typeof v.id==="string"&&typeof v.name==="string"&&typeof v.query==="string"&&v.query.length<=12000).slice(0,10));
  }catch{}},[]);
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
  function navigate(href:string){ if(isDirty)guardedNavigate(href);else router.push(href); }
  function change(values:Record<string,string|null>){navigate(listFilterHref(params.toString(),values));}
  function writeSaved(next:Saved[]) {
    try {localStorage.setItem(key,JSON.stringify(next));setSaved(next);setError("");return true;}
    catch {setError("ブラウザに保存できません。保存容量・ブラウザの設定を確認してください。");return false;}
  }
  function saveSearch() {
    if(!name.trim()){setError("検索条件の名前を入力してください。");return;}
    if(saved.length>=10){setError("検索条件は10件までです。不要な条件を削除してください。");return;}
    const source=Object.fromEntries(params);
    delete source.offset;delete source.advanced;
    const query=buildListReturnQuery(source);
    if(query.length>12000){setError("検索条件が長すぎます。条件を減らして保存してください。");return;}
    if(writeSaved([...saved,{id:crypto.randomUUID(),name:name.trim().slice(0,60),query}]))setName("");
  }
  function renameSearch() {
    if(!editing?.name.trim()){setError("検索条件の名前を入力してください。");return;}
    if(writeSaved(saved.map(s=>s.id===editing.id?{...s,name:editing.name.trim().slice(0,60)}:s)))setEditing(null);
  }
  function replaceSearch(id:string) {
    const source=Object.fromEntries(params);
    delete source.offset;delete source.advanced;
    const query=buildListReturnQuery(source);
    if(query.length>12000){setError("検索条件が長すぎます。条件を減らしてください。");return;}
    if(writeSaved(saved.map(s=>s.id===id?{...s,query}:s)))setOverwriteId(null);
  }
  const chips=[
    ...(params.get("q")?[{key:"q",label:`商品名・番号：${params.get("q")}`,clear:()=>change({q:null})}]:[]),
    ...categoryIds.map(id=>({key:id,label:categories.find(c=>c.id===id)?.name??"カテゴリ",clear:()=>change({categoryIds:categoryIds.filter(c=>c!==id).join(",")})})),
    ...(params.get("locationId")?[{key:"locationId",label:locations.find(l=>l.id===params.get("locationId"))?.name??"保管場所",clear:()=>change({locationId:null})}]:[]),
    ...(params.get("adv")?[{key:"adv",label:"詳細検索",clear:()=>change({adv:null})}]:[]),
  ];
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="適用中の検索条件">
        {chips.length?chips.map(c=><button key={c.key} type="button" onClick={c.clear} className="max-w-64 truncate rounded-md border border-teal-100 bg-teal-50 px-2 py-1 text-xs text-teal-900" title={c.label} aria-label={c.label+"を解除"}>{c.label} ×</button>):<span className="text-xs text-gray-500">すべての在庫</span>}
        {chips.length>0&&<button type="button" onClick={()=>change({q:null,categoryIds:null,locationId:null,statusId:null,adv:null})} className="px-2 text-xs text-gray-600 underline">条件をクリア</button>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-gray-600">並べ替え
          <select aria-label="並べ替える項目" className={button} value={sort.field} onChange={e=>change({sort:e.target.value})}>
            {INVENTORY_SORT_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <select aria-label="並べ替えの順序" className={button} value={sort.direction} onChange={e=>change({direction:e.target.value})}>
          <option value="desc">降順</option><option value="asc">昇順</option>
        </select>
        <button type="button" className={button} onClick={()=>setOpen("saved")}>保存した検索</button>
        <select aria-label="行の表示" className={button} value={density} onChange={e=>setDensity(e.target.value as "normal"|"compact")}>
          <option value="normal">標準表示</option><option value="compact">コンパクト表示</option>
        </select>
        <button type="button" className={button} onClick={()=>setOpen("columns")}>表示項目</button>
      </div>
    </div>
    <dialog ref={dialog} onCancel={()=>setOpen(null)} onClose={()=>setOpen(null)} className="max-h-[85vh] w-[560px] max-w-[calc(100vw-32px)] rounded-xl p-0 shadow-xl backdrop:bg-black/30" aria-labelledby="inventory-list-tools-title">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white p-4">
        <h2 id="inventory-list-tools-title" className="font-bold">{open==="columns"?"一覧の表示項目":"保存した検索条件"}</h2>
        <button type="button" onClick={()=>setOpen(null)} className={button}>閉じる</button>
      </div>
      <div className="p-4">
        {open==="columns"?<ListColumnSettings customFieldDefs={customFieldDefs}/>:open==="saved"?<>
          <p className="mb-4 text-sm text-gray-600">現在の検索・絞り込み・並べ替えを、このブラウザに10件まで保存できます。</p>
          <form className="mb-4 flex gap-2" onSubmit={e=>{e.preventDefault();saveSearch();}}>
            <input aria-label="検索条件の名前" placeholder="例：出品待ちのチェア" maxLength={60} value={name} onChange={e=>setName(e.target.value)} className="min-w-0 flex-1 rounded-lg border px-3 py-2"/>
            <button className={button} type="submit">現在の条件を保存</button>
          </form>
          {error&&<p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
          {saved.length===0?<p className="text-sm text-gray-500">保存した検索条件はありません。</p>:<ul className="divide-y">{saved.map(s=><li key={s.id} className="space-y-2 py-3">
            {editing?.id===s.id?<form className="flex gap-2" onSubmit={e=>{e.preventDefault();renameSearch();}}>
              <input autoFocus aria-label="変更後の検索条件名" maxLength={60} value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} className="min-w-0 flex-1 rounded-lg border px-3 py-2"/>
              <button type="submit" className={button}>保存</button>
              <button type="button" className={button} onClick={()=>setEditing(null)}>キャンセル</button>
            </form>:<div className="flex items-center gap-3">
              <button type="button" className="min-w-0 flex-1 truncate text-left font-medium text-teal-900" onClick={()=>{setOpen(null);navigate("/inventory?"+buildListReturnQuery(Object.fromEntries(new URLSearchParams(s.query))));}}>{s.name}</button>
              <button type="button" className="text-sm text-gray-600 underline" aria-label={s.name+"の名前を変更"} onClick={()=>{setEditing({id:s.id,name:s.name});setOverwriteId(null);}}>名前変更</button>
              <button type="button" className="text-sm text-gray-600 underline" aria-label={s.name+"の条件を更新"} onClick={()=>{setOverwriteId(s.id);setEditing(null);}}>条件更新</button>
              <button type="button" className="text-sm text-gray-500 underline" aria-label={s.name+"を削除"} onClick={()=>writeSaved(saved.filter(v=>v.id!==s.id))}>削除</button>
            </div>}
            {overwriteId===s.id&&<div className="rounded-lg bg-amber-50 p-3 text-sm">
              <p>「{s.name}」を現在の検索・絞り込み・並べ替えに更新します。</p>
              <div className="mt-2 flex gap-2"><button type="button" className={button} onClick={()=>replaceSearch(s.id)}>現在の条件に更新</button>
              <button type="button" className={button} onClick={()=>setOverwriteId(null)}>キャンセル</button></div>
            </div>}
          </li>)}</ul>}
        </>:null}
      </div>
    </dialog>
  </>;
}

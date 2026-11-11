"use client";

import {useEffect,useRef,useState} from "react";
import {getInventoryQuantityTotalAction} from "@/app/actions/inventoryCount";
import type {InventoryListFilters} from "@/lib/inventory/queries";

/** Calculated only on request; the inventory list never waits for this aggregate. */
export function InventoryQuantityTotal({filters,adv,known}:{filters:InventoryListFilters;adv?:string;known?:number}) {
  const [result,setResult]=useState<number|null>(null);
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function show(){
    if(busy)return;
    if(known!==undefined){setResult(known);return;}
    setBusy(true);setFailed(false);
    try{
      const value=await getInventoryQuantityTotalAction(filters,adv);
      if(!mounted.current)return;
      if(value.ok)setResult(value.totalQuantity);else setFailed(true);
    }catch{if(mounted.current)setFailed(true);}
    finally{if(mounted.current)setBusy(false);}
  }
  return <span className="ml-3 inline-flex items-center gap-2 text-xs text-gray-600">
    {result!==null?<span role="status">数量合計 {(known??result).toLocaleString("ja-JP")}</span>:<button type="button" disabled={busy} onClick={show} className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 disabled:opacity-50">{busy?"数量を集計中…":failed?"数量合計を再取得":"数量合計を表示"}</button>}
    {failed&&<span role="alert">取得できませんでした</span>}
  </span>;
}

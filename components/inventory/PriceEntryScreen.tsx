'use client';
import React,{useEffect,useRef,useState} from 'react';
import type {PriceEntryItem,PriceEntryChange} from '../../lib/inventory/plannedPrice';
import {parsePriceEntryChange} from '../../lib/inventory/plannedPrice';
import type {InventoryItem,InventoryThumbnail} from '../../mobile/src/domain/inventory';
import {PricePhotoEditor} from './PricePhotoEditor';

export type PriceEntryTransport=<T>(url:string,body?:unknown)=>Promise<T>;
export async function priceEntryRequest<T>(url:string,body?:unknown):Promise<T>{
 const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
 const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'通信できませんでした。'),{code:result.code});return result;
}
type Draft={name:string;note:string;price:string};
const draftFor=(r:PriceEntryItem):Draft=>({name:r.name,note:r.note,price:r.plannedSalePrice==null?'':String(r.plannedSalePrice)});
const changed=(r:PriceEntryItem,d?:Draft)=>!!d&&(d.name!==r.name||d.note!==r.note||d.price!==draftFor(r).price);
export function PriceEntryScreen({embedded=false,onClose,onDirty,onSaveReady,request=priceEntryRequest}:{embedded?:boolean;onClose?:()=>void;onDirty?:(dirty:boolean)=>void;onSaveReady?:(save:(()=>Promise<boolean>)|null)=>void;request?:PriceEntryTransport}){
 const [items,setItems]=useState<PriceEntryItem[]>([]),[drafts,setDrafts]=useState<Record<string,Draft>>({}),[loading,setLoading]=useState(true),[error,setError]=useState(''),[limit,setLimit]=useState(40),[busy,setBusy]=useState(false),[photo,setPhoto]=useState<PriceEntryItem|null>(null);
 const [results,setResults]=useState<Record<string,{ok:boolean;message:string}>>({}),[reload,setReload]=useState(0);
 const pending=useRef(new Map<string,PriceEntryChange>()),locked=useRef(false),rowsRef=useRef(items),draftRef=useRef(drafts);
 rowsRef.current=items;draftRef.current=drafts;
 const visibleIds=items.slice(0,limit).map(r=>r.id).join(',');
 const dirty=items.some(row=>changed(row,drafts[row.id]));
 useEffect(()=>{onDirty?.(dirty||busy);return()=>onDirty?.(false);},[dirty,busy,onDirty]);
 useEffect(()=>{if(!dirty&&!busy)return;const stop=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',stop);return()=>window.removeEventListener('beforeunload',stop);},[dirty,busy]);
 useEffect(()=>{let active=true;setLoading(true);setError('');void request<{items:PriceEntryItem[]}>('/api/inventory/planned-price').then(data=>{if(active){setItems(data.items);setDrafts({});setResults({});setLimit(40);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[request,reload]);
 // Resolve Photo Station thumbnails only for the visible portion; price editing stays available.
 useEffect(()=>{let active=true;const ids=visibleIds?visibleIds.split(','):[];void(async()=>{for(let start=0;active&&start<ids.length;start+=40){try{const data=await request<{items:InventoryThumbnail[]}>('/api/mobile/inventory?images=only&ids='+ids.slice(start,start+40).join(','));if(active)setItems(rows=>rows.map(row=>{const image=data.items.find(p=>p.id===row.id);return image?.thumbnailUrl?{...row,imageUrl:image.thumbnailUrl}:row;}));}catch{}}})();return()=>{active=false;};},[visibleIds,request]);
 function edit(row:PriceEntryItem,key:keyof Draft,value:string){if(locked.current||pending.current.has(row.id))return;setDrafts(all=>({...all,[row.id]:{...draftFor(row),...all[row.id],[key]:value}}));setResults(all=>{const next={...all};delete next[row.id];return next;});}
 async function saveOne(row:PriceEntryItem){
  const draft=draftRef.current[row.id]??draftFor(row);
  try{
   if(draft.price.trim()&&!/^\d+$/.test(draft.price.trim()))throw Error('販売予定価格は数字だけで入力してください。');
   const input=pending.current.get(row.id)??parsePriceEntryChange({id:row.id,expectedUpdatedAt:row.updatedAt,mutationId:crypto.randomUUID(),name:draft.name,note:draft.note,plannedSalePrice:draft.price.trim()===''?null:Number(draft.price)});
   pending.current.set(row.id,input);
   const {item}=await request<{item:PriceEntryItem}>('/api/inventory/planned-price',input);
   pending.current.delete(row.id);setItems(rows=>rows.map(r=>r.id===item.id?{...item,imageUrl:item.imageUrl??r.imageUrl}:r));
   setDrafts(all=>{const next={...all};delete next[row.id];return next;});setResults(all=>({...all,[row.id]:{ok:true,message:item.plannedSalePrice==null?'商品情報を保存しました（価格は未入力）':'保存しました'}}));return true;
  }catch(e){const issue=e as Error&{code?:string};if(['CONFLICT','INVALID_INPUT','OUTBOUND_RESERVED'].includes(issue.code??'')||!pending.current.has(row.id))pending.current.delete(row.id);
   setResults(all=>({...all,[row.id]:{ok:false,message:issue.message||'保存結果を確認できません。再確認してください。'}}));return false;}
 }
 async function saveAll(id?:string){if(locked.current)return false;locked.current=true;setBusy(true);let ok=true;
  try{for(const row of rowsRef.current.filter(r=>id?r.id===id:changed(r,draftRef.current[r.id])||pending.current.has(r.id)))if(!await saveOne(row))ok=false;return ok;}finally{locked.current=false;setBusy(false);}
 }
 const saveRef=useRef(saveAll);saveRef.current=saveAll;
 useEffect(()=>{onSaveReady?.(()=>saveRef.current());return()=>onSaveReady?.(null);},[onSaveReady]);
 const leave=()=>{if(busy)return;if(dirty&&!window.confirm('入力内容がまだ保存されていません。保存せずに戻りますか？'))return;onClose?.();};
 const refresh=()=>{if(busy)return;if(dirty&&!window.confirm('未保存の入力を破棄して、最新の一覧を読み込みますか？'))return;pending.current.clear();setReload(n=>n+1);};
 async function readLatest(row:PriceEntryItem){
  try{const {item}=await request<{item:InventoryItem}>('/api/mobile/inventory/'+row.id);
   if(item.plannedSalePrice!==null){
    if(!window.confirm(`他の操作で販売予定価格が${item.plannedSalePrice.toLocaleString()}円に設定されています。この行の未保存の入力を破棄して、最新の内容を表示しますか？`))return;
    setDrafts(all=>{const next={...all};delete next[row.id];return next;});
   }else setDrafts(all=>{const d=all[row.id];return d?{...all,[row.id]:{...d,name:d.name===row.name?item.name:d.name,note:d.note===row.note?item.note:d.note}}:all;});
   setItems(rows=>rows.map(r=>r.id===row.id?{...r,...item,imageUrl:item.thumbnailUrl}:r));
   setResults(all=>({...all,[row.id]:{ok:item.plannedSalePrice!==null,message:item.plannedSalePrice!==null?'入力済みの最新情報を表示しています。':'最新の商品情報を読み込みました。入力内容を確認して保存してください。'}}));
  }catch{setError('最新の商品を取得できませんでした。');}
 }
 return <section className={'price-entry'+(embedded?' price-entry-mobile':'')}>
  <style>{priceEntryCss}</style>
  <header className="pe-header"><div>{onClose&&<button type="button" className="pe-back" onClick={leave} disabled={busy}>〈 戻る</button>}<h1>販売予定価格入力</h1><p>補修待ち・撮影待ち・出品待ちの、価格が未入力の商品</p></div><button type="button" className="pe-button" disabled={loading||busy} onClick={refresh}>一覧を更新</button></header>
  <div className="pe-toolbar"><span>{loading?'未入力の商品を確認中…':`未入力 ${items.filter(r=>r.plannedSalePrice==null).length}件`}<small>販売予定価格は送料別です</small></span><button className="pe-primary" type="button" disabled={loading||busy||!dirty} onClick={()=>void saveAll()}>{busy?'保存を確認中…':'入力した商品を保存'}</button></div>
  <div className="pe-list" aria-busy={loading||busy}>
   {error&&<p role="alert" className="pe-error">{error}</p>}{!loading&&!error&&!items.length&&<div className="pe-empty">販売予定価格が未入力の商品はありません。</div>}
   {items.slice(0,limit).map((row,index)=>{const draft=drafts[row.id]??draftFor(row),result=results[row.id],uncertain=pending.current.has(row.id);return <article key={row.id} className={'pe-card'+(result?.ok?' pe-saved':'')} aria-label={row.sku+'の価格入力'}>
    <div className="pe-photo"><button type="button" onClick={()=>setPhoto(row)} disabled={busy||uncertain||changed(row,draft)} aria-label={row.sku+'の写真を確認・変更'}>{row.imageUrl?<img src={row.imageUrl} alt={row.name} loading={index<4?'eager':'lazy'} decoding="async"/>:<span>画像なし</span>}</button><button className="pe-image-edit" disabled={busy||uncertain||changed(row,draft)} title={changed(row,draft)?"入力内容を保存してから写真を変更してください":undefined} onClick={()=>setPhoto(row)} type="button">写真を確認・変更</button>{changed(row,draft)&&<small>入力内容の保存後に写真を変更できます</small>}</div>
    <div className="pe-name"><small>{row.sku}</small><label>商品名<textarea aria-label={row.sku+'の商品名'} value={draft.name} rows={3} disabled={busy||uncertain||row.plannedSalePrice!==null} onChange={e=>edit(row,'name',e.target.value)}/></label></div>
    <label className="pe-note">備考<textarea aria-label={row.sku+'の備考'} value={draft.note} rows={3} placeholder="備考なし" disabled={busy||uncertain||row.plannedSalePrice!==null} onChange={e=>edit(row,'note',e.target.value)}/></label>
    <div className="pe-price"><label>販売予定価格<span className="pe-money"><input aria-label={row.sku+'の販売予定価格'} inputMode="numeric" pattern="[0-9]*" value={draft.price} placeholder="未入力" disabled={busy||uncertain||row.plannedSalePrice!==null} onChange={e=>edit(row,'price',e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void saveAll(row.id);}}}/><span>円</span></span></label><button className="pe-primary" type="button" disabled={busy||(!changed(row,draft)&&!uncertain)} onClick={()=>void saveAll(row.id)}>{uncertain?'保存結果を再確認':result?.ok&&row.plannedSalePrice!==null?'保存済み':'保存'}</button>
    {result&&<p role={result.ok?'status':'alert'} className={result.ok?'pe-success':'pe-error'}>{result.message}</p>}
    {result&&!result.ok&&!uncertain&&<button className="pe-back" type="button" onClick={()=>void readLatest(row)}>最新の内容を確認</button>}
    </div></article>;})}
   {!loading&&limit<items.length&&<button type="button" className="pe-more pe-button" onClick={()=>setLimit(n=>n+40)}>続きを表示（残り {items.length-limit}件）</button>}
  </div>
  {photo&&<PricePhotoEditor item={photo} request={request} onClose={()=>setPhoto(null)} onSaved={item=>{setItems(rows=>rows.map(row=>row.id===item.id?{...row,name:item.name,note:item.note,plannedSalePrice:item.plannedSalePrice,updatedAt:item.updatedAt,imageUrl:item.thumbnailUrl}:row));}}/>}
 </section>;
}

export const priceEntryCss=`.price-entry{display:flex;flex-direction:column;background:#f7f8fa;color:#25322e;min-width:0;padding:24px;font:14px/1.5 system-ui,sans-serif}.price-entry *{box-sizing:border-box}.price-entry button,.price-entry input,.price-entry textarea{font:inherit}.price-entry button{cursor:pointer}.price-entry button:disabled{cursor:default;opacity:.5}.price-entry h1{font-size:24px;margin:4px 0}.price-entry p{margin:6px 0}.pe-header{display:flex;justify-content:space-between;align-items:center;gap:12px}.pe-header>.pe-button{white-space:nowrap;flex-shrink:0}.pe-header p,.pe-toolbar small,.pe-name small{color:#67746e}.pe-toolbar{position:sticky;top:0;z-index:2;background:#f7f8fa;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 0}.pe-toolbar span{font-weight:700}.pe-toolbar small{display:block;font-size:12px;font-weight:400}.pe-button,.pe-primary,.pe-back,.pe-image-edit{border:1px solid #cbd4cf;border-radius:8px;padding:10px 14px;background:white;color:#254d44;min-height:42px}.pe-primary{background:#286256;color:white;border-color:#286256;font-weight:600}.pe-back{border:0;background:transparent;padding:5px}.pe-list{display:flex;flex-direction:column;gap:14px}.pe-card{display:grid;grid-template-columns:150px minmax(180px,1.5fr) minmax(160px,1fr) 180px;gap:18px;align-items:start;border:1px solid #dee5e0;border-radius:14px;background:#fff;padding:18px}.pe-photo>button:first-child{width:100%;padding:0;border:0;background:#f2f3ef;border-radius:8px;overflow:hidden;aspect-ratio:1;display:grid;place-items:center;color:#6d7871}.pe-photo img{width:100%;height:100%;object-fit:contain}.pe-image-edit{font-size:12px!important;width:100%;margin-top:8px;padding:6px}.price-entry label{font-weight:600;display:block}.price-entry textarea,.price-entry input{background:#fff;color:#24332c;width:100%;border:1px solid #bdcbc3;border-radius:8px;padding:10px;outline-offset:2px}.price-entry textarea{resize:vertical;min-height:100px;display:block;margin-top:6px;font-weight:400}.pe-name small{display:block;margin-bottom:4px}.pe-money{display:flex;align-items:center;gap:8px;margin:6px 0 10px}.pe-money input{text-align:right;font-size:20px;font-weight:600}.pe-price>.pe-primary{width:100%}.pe-success{color:#176540;font-size:12px}.pe-error{color:#b42318;font-size:13px}.pe-saved{border-color:#9ccdb3;background:#f8fdf9}.pe-empty{padding:50px 20px;text-align:center;background:white;border-radius:12px}.pe-more{align-self:center;margin:12px}.price-entry-mobile{height:100%;min-height:0;padding:14px;overflow:hidden;flex:1}.price-entry-mobile .pe-list{overflow-y:auto;overscroll-behavior:contain;min-height:0;padding-bottom:calc(24px + env(safe-area-inset-bottom));}.price-entry-mobile .pe-header h1{font-size:21px}.price-entry-mobile .pe-header p{font-size:12px}.price-entry-mobile .pe-toolbar{position:static;flex-shrink:0}.price-entry-mobile .pe-card{grid-template-columns:110px minmax(0,1fr);gap:12px;padding:12px}.price-entry-mobile .pe-name textarea{min-height:128px}.price-entry-mobile .pe-note{grid-column:1/-1}.price-entry-mobile .pe-note textarea{min-height:75px}.price-entry-mobile .pe-price{grid-column:1/-1}.price-entry-mobile .pe-money input{min-height:50px;font-size:22px}.price-entry-mobile .pe-price>.pe-primary{min-height:48px}.pe-modal-shade{position:fixed;inset:0;z-index:100;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px}.pe-modal{background:white;border-radius:14px;padding:20px;width:min(720px,100%);max-height:90dvh;overflow:auto}.pe-photo-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.pe-photo-grid img{width:100%;aspect-ratio:1;object-fit:contain;background:#f5f5f5}.pe-photo-grid button{width:100%;border:1px solid #d9a8a8;background:white;color:#ad2929;border-radius:6px;padding:7px}.pe-photo-footer{display:flex;justify-content:space-between;gap:10px;margin:18px 0}.pe-modal .pe-button{display:inline-block}.pe-modal h2{margin-top:0}@media(max-width:900px){.price-entry:not(.price-entry-mobile) .pe-card{grid-template-columns:120px 1fr 1fr}.price-entry:not(.price-entry-mobile) .pe-price{grid-column:2/-1}.pe-photo-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}`;

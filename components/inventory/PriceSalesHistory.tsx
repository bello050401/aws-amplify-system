'use client';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {InventoryItem} from '../../mobile/src/domain/inventory';
import {isShippedInventory,priceHistoryFields,priceHistoryQuery,priceHistoryValue,type PriceHistoryPorts} from '../../mobile/src/domain/priceHistory';

/** Read-only overlay. The price-entry list remains mounted underneath, preserving its scroll and drafts. */
export function PriceSalesHistory({name,sku,ports,onClose}:{name:string;sku:string;ports:PriceHistoryPorts;onClose:()=>void}){
 const [query,setQuery]=useState(()=>priceHistoryQuery(name)),[items,setItems]=useState<InventoryItem[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [more,setMore]=useState(false),[offset,setOffset]=useState(0),[total,setTotal]=useState<number|null>(null),[visible,setVisible]=useState(12),[searched,setSearched]=useState('');
 const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<InventoryItem|null>(null),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState('');
 const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0),detailGeneration=useRef(0),portsRef=useRef(ports),lastQuery=useRef(''),queryRef=useRef(query),closeRef=useRef(onClose);
 portsRef.current=ports;queryRef.current=query;closeRef.current=onClose;
 const close=()=>{dialog.current?.close();closeRef.current();};
 const details=useRef(new Map<string,InventoryItem>()),imageAttempts=useRef(new Set<string>());
 const cards=useRef(new Map<string,HTMLElement>());
 useLayoutEffect(()=>{if(selected)cards.current.get(selected)?.scrollIntoView({block:'start',behavior:'auto'});},[selected]);
 async function search(append=false){
  const text=append?lastQuery.current:queryRef.current.trim(),version=++generation.current;
  if(!text){setLoading(false);setError('商品名やブランド名を入力してください。');return;}
  setLoading(true);setError('');
  if(!append){setItems([]);setSelected(null);setDetail(null);detailGeneration.current++;setVisible(12);setTotal(null);setMore(false);imageAttempts.current.clear();lastQuery.current=text;setSearched(text);}
  try{const page=await portsRef.current.search(text,append?offset:0);if(version!==generation.current)return;
   const found=page.items.filter(isShippedInventory);
   setItems(old=>append?[...old,...found.filter(row=>!old.some(r=>r.id===row.id))]:found);setMore(page.hasMore);setOffset(page.nextOffset??(append?offset:0)+page.items.length);setTotal(page.total??null);
   if(append)setVisible(n=>n+12);
  }catch{if(version===generation.current)setError('検索できませんでした。通信を確認して、もう一度検索してください。');}
  finally{if(version===generation.current)setLoading(false);}
 }
 useEffect(()=>{const el=dialog.current;el?.showModal();void search();return()=>{generation.current++;detailGeneration.current++;details.current.clear();el?.close();};},[]);
 const imageIds=items.slice(0,visible).filter(row=>!row.thumbnailUrl).map(row=>row.id).join(',');
 useEffect(()=>{if(!imageIds||!portsRef.current.thumbnails)return;const version=generation.current,ids=imageIds.split(',').filter(id=>!imageAttempts.current.has(id));if(!ids.length)return;ids.forEach(id=>imageAttempts.current.add(id));
  void portsRef.current.thumbnails(ids).then(images=>{if(version===generation.current)setItems(rows=>rows.map(row=>{const image=images.find(i=>i.id===row.id);return image?.thumbnailUrl?{...row,thumbnailUrl:image.thumbnailUrl}:row;}));}).catch(()=>{});
 },[imageIds]);
 async function open(row:InventoryItem,retry=false){
  if(selected===row.id&&!retry){setSelected(null);setDetail(null);detailGeneration.current++;return;}
  setSelected(row.id);setDetail(null);setDetailError('');setDetailLoading(true);const version=++detailGeneration.current;
  try{const value=details.current.get(row.id)??await portsRef.current.detail(row.id);if(version!==detailGeneration.current)return;
   if(!isShippedInventory(value)){setDetailError('現在は発送完了の商品ではありません。一覧を検索し直してください。');return;}
   details.current.set(row.id,value);setDetail(value);
  }catch{if(version===detailGeneration.current)setDetailError('販売情報を取得できませんでした。');}
  finally{if(version===detailGeneration.current)setDetailLoading(false);}
 }
 const fieldOrder=['saleCommission','saleEndDate','market','saleStartDate','externalProductId','listingNotes'];
 const fields=priceHistoryFields(ports.features).sort((a,b)=>fieldOrder.indexOf(a.key)-fieldOrder.indexOf(b.key));
 return <dialog className="pe-history" ref={dialog} aria-labelledby="pe-history-title" onCancel={e=>{e.preventDefault();close();}}>
  <style>{priceHistoryCss}</style>
  <header className="ph-header"><button type="button" autoFocus onClick={close} aria-label="販売情報を閉じて価格入力に戻る">〈 価格入力へ</button><span>販売実績を参考に</span><h2 id="pe-history-title">過去の販売を確認</h2></header>
  <form className="ph-search" onSubmit={e=>{e.preventDefault();e.currentTarget.querySelector('input')?.blur();void search();}}><label htmlFor="ph-query">商品名・ブランド名で検索</label><div><input id="ph-query" type="search" value={query} maxLength={200} onChange={e=>setQuery(e.target.value)} enterKeyHint="search"/><button type="submit" disabled={loading||!query.trim()}>検索</button></div><p><span>発送完了のみ</span> 検索語は自由に変更できます</p></form>
  <div className="ph-results" aria-busy={loading}>
   {error&&<p role="alert" className="ph-error">{error}</p>}
   <div className="ph-result-count" role="status">{loading&&!items.length?'検索中…':error&&!items.length?'検索結果を取得できません':`${total??items.length}${more&&total===null?'件以上':'件'}の販売実績`}<small>商品をタップして販売情報を表示</small></div>
   {!loading&&!error&&!items.length&&<div className="ph-empty"><strong>一致する商品がありません</strong><p>ブランド名や「チェア」など、<br/>短い言葉に変えて検索してください。</p></div>}
   {items.slice(0,visible).map(row=><article ref={el=>{if(el)cards.current.set(row.id,el);else cards.current.delete(row.id);}} className={'ph-card'+(selected===row.id?' ph-open':'')} key={row.id}>
    <button type="button" className="ph-product" aria-expanded={selected===row.id} onClick={()=>void open(row)} aria-label={row.sku+'の販売情報'}>
     {row.thumbnailUrl?<img src={row.thumbnailUrl} alt="" loading="lazy" decoding="async"/>:<span className="ph-no-photo">画像なし</span>}
     <span className="ph-product-name"><small>{row.sku}</small><strong>{row.name}</strong><span>発送完了<b>販売情報 {selected===row.id?'−':'＋'}</b></span></span>
    </button>
    {selected===row.id&&<div className="ph-details">
     {detailLoading&&<p role="status">販売情報を確認中…</p>}
     {detailError&&<div role="alert" className="ph-error">{detailError}<button type="button" onClick={()=>void open(row,true)}>再読み込み</button></div>}
     {detail&&<><div className="ph-sale-price"><span>販売価格<small>登録されている金額</small></span><strong>{priceHistoryValue({key:'salePrice',label:'販売価格',section:'販売情報',kind:'money'},detail.details?.salePrice)}</strong></div>
      <dl>{fields.filter(f=>f.key!=='salePrice'&&f.key!=='listingNotes').map(field=><div key={field.key}><dt>{field.label}</dt><dd>{priceHistoryValue(field,detail.details?.[field.key])}</dd></div>)}</dl>
      {fields.some(f=>f.key==='listingNotes')&&<details className="ph-notes"><summary>出品情報・メモを確認</summary><p>{detail.details?.listingNotes?.trim()||'未入力'}</p></details>}</>}
    </div>}
   </article>)}
   {loading&&items.length>0&&<p role="status">読み込み中…</p>}
   {(visible<items.length||more)&&<button type="button" className="ph-more" disabled={loading} onClick={()=>visible<items.length?setVisible(n=>n+12):void search(true)}>続きを表示</button>}
   {!loading&&searched&&<span className="ph-search-term">「{searched}」の検索結果</span>}
  </div>
  <footer className="ph-footer"><small>価格入力中：{sku}</small><button type="button" onClick={close}>価格入力に戻る <span aria-hidden="true">→</span></button></footer>
 </dialog>;
}

export const priceHistoryCss=`
.ph-card:not(.ph-open) .ph-product-name>strong{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.ph-notes{border-top:1px solid #eff1e9;margin-top:10px}.ph-notes summary{padding:14px 0;min-height:44px;cursor:pointer;color:#55745e;font-size:12px}.ph-notes p{font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 12px!important}.ph-card{scroll-margin-top:4px}
.pe-history{--ph-ink:#263d38;position:fixed;inset:0;width:100%;max-width:560px;height:100%;height:100dvh;max-height:100dvh;margin:auto;padding:0;border:0;background:#f7f6f1;color:var(--ph-ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden}.pe-history[open]{display:flex;flex-direction:column}.pe-history::backdrop{background:#182c2866}.pe-history *{box-sizing:border-box}.pe-history button,.pe-history input{font:inherit}.pe-history button{cursor:pointer;touch-action:manipulation}.pe-history button:disabled{opacity:.5}.ph-header{padding:calc(12px + env(safe-area-inset-top)) 22px 14px;flex-shrink:0;background:#f7f6f1}.ph-header>button{display:block;border:0;background:none;color:#466b60;font-size:14px;min-height:44px;padding:0 8px 0 0}.ph-header>span{display:block;font-size:10px;letter-spacing:1.5px;color:#889184;margin:10px 0 3px}.ph-header h2{font-size:24px;margin:0;letter-spacing:-.6px}.ph-search{margin:0;padding:4px 22px 14px;border-bottom:1px solid #e4e7df;flex-shrink:0}.ph-search>label{font-size:11px;color:#778474;display:block;margin-bottom:6px}.ph-search>div{display:flex;gap:8px}.ph-search input{flex:1;min-width:0;width:100%;border:1px solid #d7dfd4!important;border-radius:12px!important;background:white;padding:12px!important;font-size:16px!important;outline:none}.ph-search input:focus{border-color:#578272!important;box-shadow:0 0 0 3px #dfe9de}.ph-search button{min-width:64px;border:0;border-radius:12px;background:var(--ph-ink);color:#fff;padding:10px}.ph-search p{font-size:11px;color:#859080;margin:10px 0 0}.ph-search p>span{color:#4d7261;background:#e9eee5;padding:4px 8px;border-radius:20px;margin-right:4px}.ph-results{overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:0;padding:16px 18px 24px;-webkit-overflow-scrolling:touch}.ph-result-count{color:#466354;font-size:13px;margin:0 2px 12px}.ph-result-count small{display:block;font-size:10px;color:#8a9385;margin-top:2px}.ph-card{background:white;border:1px solid #e5e8df;border-radius:18px;overflow:hidden;margin-bottom:12px}.ph-open{border-color:#9db7a5;box-shadow:0 4px 18px #264e3710}.ph-product{border:0;background:transparent;width:100%;display:flex;gap:13px;align-items:start;text-align:left;padding:14px;color:inherit;min-height:112px}.ph-product img,.ph-no-photo{width:80px;height:80px;flex-shrink:0;border-radius:11px;object-fit:contain;background:#f2f2ec}.ph-no-photo{display:grid;place-items:center;font-size:10px;color:#9ca294}.ph-product-name{min-width:0;flex:1}.ph-product-name>small{display:block;font-size:10px;color:#8a9384;margin-bottom:4px}.ph-product-name>strong{display:block;font-size:14px;line-height:1.55;font-weight:600;overflow-wrap:anywhere}.ph-product-name>span{display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;font-size:11px;color:#8a9384;margin-top:10px}.ph-product-name b{color:#557c69;font-size:11px;font-weight:500}.ph-details{border-top:1px solid #eff1e9;padding:16px}.ph-sale-price{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#eef3e9;border-radius:12px;padding:13px 14px;margin-bottom:12px}.ph-sale-price>span{font-size:12px;color:#63775b}.ph-sale-price small{display:block;font-size:9px;color:#89947f;margin-top:2px}.ph-sale-price strong{font-size:25px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}.ph-details dl{margin:0}.ph-details dl>div{display:grid;grid-template-columns:92px minmax(0,1fr);gap:10px;padding:10px 0;border-bottom:1px solid #eff1e9;font-size:12px}.ph-details dt{color:#87917e}.ph-details dd{margin:0;text-align:right;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.ph-error{color:#ac3c2c;font-size:13px}.ph-error button{display:block;margin-top:12px;border:1px solid #d5ded2;background:white;border-radius:8px;padding:10px;color:#426854}.ph-empty{text-align:center;padding:40px 8px}.ph-empty p{color:#8a9384;font-size:13px;line-height:1.8}.ph-more{width:100%;background:white;border:1px solid #dce4d7;color:#55745e;border-radius:12px;min-height:46px}.ph-search-term{font-size:10px;color:#9aa28f;display:block;margin:14px 4px;overflow-wrap:anywhere}.ph-footer{flex-shrink:0;padding:10px 22px calc(14px + env(safe-area-inset-bottom));background:#f7f6f1;border-top:1px solid #e1e6dc}.ph-footer>small{display:block;color:#8b9583;font-size:10px;margin:0 0 6px}.ph-footer>button{width:100%;min-height:50px;border:0;border-radius:14px;background:var(--ph-ink);color:white;font-weight:600;display:flex;align-items:center;justify-content:center;gap:18px}.ph-header button:focus-visible,.pe-history button:focus-visible{outline:2px solid #4c8068;outline-offset:-3px}
`;

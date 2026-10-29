'use client';
import React,{useEffect,useRef,useState} from 'react';
import type {PriceEntryItem} from '../../lib/inventory/plannedPrice';
import type {PriceEntryTransport} from './PriceEntryScreen';
import {draftFor,type InventoryItem,type InventoryPhoto} from '../../mobile/src/domain/inventory';

async function photoRequest(url:string,method:string,body?:unknown){
 const response=await fetch(url,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Bello-Mobile':'1'},body:body?JSON.stringify(body):undefined});
 const result=await response.json();if(!response.ok)throw Object.assign(Error(result.message||result.error||'写真の保存を確認できません。'),{code:result.code||result.error});return result;
}
async function upload(file:File,id:string){
 if(!/^image\//.test(file.type)||file.size>25*1024*1024)throw Error('25MB以内の画像を選択してください。');
 const url=URL.createObjectURL(file);
 try{const image=await new Promise<HTMLImageElement>((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('この画像を読み込めません。JPEG・PNG形式を選択してください。'));img.src=url;});
  const canvas=document.createElement('canvas'),scale=Math.min(1,2000/Math.max(image.naturalWidth,image.naturalHeight));canvas.width=Math.round(image.naturalWidth*scale);canvas.height=Math.round(image.naturalHeight*scale);const ctx=canvas.getContext('2d');if(!ctx)throw Error('写真を準備できません。');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('写真を準備できません。')),'image/jpeg',.88));if(blob.size>3*1024*1024)throw Error('画像が大きすぎます。小さい写真を選択してください。');
  const response=await fetch('/api/mobile/images',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'image/jpeg','X-Bello-Mobile':'1','X-Photo-Id':id},body:blob});const data=await response.json();if(!response.ok)throw Error(data.message||'写真をアップロードできませんでした。');return data.storageKey as string;
 }finally{URL.revokeObjectURL(url);}
}
export function PricePhotoEditor({item,request,onClose,onSaved}:{item:PriceEntryItem;request:PriceEntryTransport;onClose:()=>void;onSaved:(item:InventoryItem)=>void}){
 const [detail,setDetail]=useState<InventoryItem|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(false);
 const pending=useRef<{method:string;url:string;body?:unknown}|null>(null),lock=useRef(false),fileInput=useRef<HTMLInputElement>(null);
 async function read(){const {item:next}=await request<{item:InventoryItem}>('/api/mobile/inventory/'+item.id);setDetail(next);onSaved(next);return next as InventoryItem;}
 useEffect(()=>{let active=true;void request<{item:InventoryItem}>('/api/mobile/inventory/'+item.id).then(({item:next})=>{if(active)setDetail(next);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[item.id,request]);
 async function commit(){const p=pending.current;if(!p)return;try{await photoRequest(p.url,p.method,p.body);pending.current=null;setRetry(false);await read();}catch(e){setRetry(!!pending.current);throw e;}}
 async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'写真を保存できませんでした。');}finally{lock.current=false;setBusy(false);}}
 async function add(file:File){if(!detail)return;await run(async()=>{const latest=await request<{item:InventoryItem}>('/api/mobile/inventory/'+item.id);if(latest.item.updatedAt!==detail.updatedAt){setDetail(latest.item);throw Error('商品が更新されています。最新の写真を確認して、もう一度追加してください。');}const storageKey=await upload(file,crypto.randomUUID());pending.current={method:'PATCH',url:'/api/mobile/inventory/'+item.id,body:{id:item.id,expectedUpdatedAt:detail.updatedAt,mutationId:crypto.randomUUID(),draft:draftFor(detail),uploads:[{storageKey,type:'NORMAL'}]}};await commit();});}
 async function remove(photo:InventoryPhoto){if(!detail||!window.confirm('この写真を削除しますか？クラウド上の画像も削除されます。'))return;await run(async()=>{pending.current=photo.source==='PHOTO_ASSET'?{method:'DELETE',url:'/api/mobile/inventory/'+item.id+'/photos/'+photo.id}:{method:'PATCH',url:'/api/mobile/inventory/'+item.id,body:{id:item.id,expectedUpdatedAt:detail.updatedAt,mutationId:crypto.randomUUID(),draft:draftFor(detail),removedPhotoIds:[photo.id]}};await commit();});}
 return <div className="pe-photo-shade"><div className="pe-photo-dialog" role="dialog" aria-modal="true" aria-label="商品写真"><header><h2>商品写真</h2><button className="pe-button" disabled={busy} onClick={onClose}>閉じる</button></header><p>{item.name}</p><p>写真の変更はその都度保存します。</p>{error&&<p className="pe-error" role="alert">{error}</p>}{retry&&<button className="pe-primary" disabled={busy} onClick={()=>void run(commit)}>保存結果を再確認</button>}
 {!detail&&!error&&<p>写真を読み込み中…</p>}<div className="pe-photo-grid">{detail?.photos?.map(p=><figure key={p.id}><img src={p.fullUrl||p.url||''} alt="商品写真"/><button className="pe-button" disabled={busy||retry||!detail.photosComplete} onClick={()=>void remove(p)}>この写真を削除</button></figure>)}</div>
 {detail&&!detail.photosComplete&&<p className="pe-error">写真をすべて取得できませんでした。閉じてから開き直してください。</p>}
 <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void add(file);}}/><button className="pe-primary" disabled={busy||retry||!detail?.photosComplete} onClick={()=>fileInput.current?.click()}>{busy?'写真を保存中…':'写真を追加'}</button>
 </div><style>{`.pe-photo-shade{position:fixed;inset:0;background:#0008;z-index:1000;display:grid;place-items:center;padding:18px}.pe-photo-dialog{background:white;border-radius:16px;padding:20px;width:min(820px,100%);max-height:90dvh;overflow-y:auto}.pe-photo-dialog header{display:flex;align-items:center;justify-content:space-between}.pe-photo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:18px 0}.pe-photo-grid figure{margin:0}.pe-photo-grid img{width:100%;max-height:320px;object-fit:contain;background:#f5f5f2}.pe-photo-grid button{display:block;width:100%;color:#b42318}`}</style></div>;
}

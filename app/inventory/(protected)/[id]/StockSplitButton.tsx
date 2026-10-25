'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {registerStockSplit} from '@/app/actions/stockSplit';
import {validateStockSplit,type StockSplitRequest} from '@/lib/inventory/stockSplitInput';
import {InventoryOperationDialog,OperationQuantity,operationInput as input} from '@/app/inventory/InventoryOperationDialog';
type Product={id:string;name:string;quantity:number;updatedAt:string;barcode?:string|null;damageNotes?:string|null};
export default function StockSplitButton({item}:{item:Product}){
 const [open,setOpen]=useState(false);
 return <><button type="button" onClick={()=>setOpen(true)} disabled={item.quantity<1} className="border border-gray-300 px-3 py-1.5 text-[12px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40">在庫分け</button>{open&&<SplitDialog item={item} close={()=>setOpen(false)}/>}</>;
}
function SplitDialog({item,close}:{item:Product;close:()=>void}){
 const router=useRouter(),lock=useRef(false),pending=useRef<StockSplitRequest|null>(null),uploads=useRef(new Map<string,string>());
 const [quantity,setQuantity]=useState('1'),[sourceName,setSourceName]=useState(item.name),[splitName,setSplitName]=useState(item.name),[damageNotes,setMemo]=useState(item.damageNotes??''),[barcode,setBarcode]=useState(item.barcode??'');
 const [photos,setPhotos]=useState<{id:string;file:File;url:string}[]>([]),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false),[review,setReview]=useState(false),[error,setError]=useState('');
 const photoRef=useRef(photos);photoRef.current=photos;useEffect(()=>()=>{for(const p of photoRef.current)URL.revokeObjectURL(p.url);},[]);
 const locked=busy||uncertain||conflict;
 const request=():StockSplitRequest=>({mutationId:crypto.randomUUID(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),sourceName,splitName,damageNotes,barcode,photos:[]});
 function confirm(){try{validateStockSplit(request(),item.quantity);setError('');setReview(true);}catch(e){setError((e as Error).message);}}
 async function save(){if(lock.current||conflict)return;lock.current=true;setBusy(true);setError('');
  try{
   if(!pending.current){
    for(const photo of photos)if(!uploads.current.has(photo.id)){
     const r=await fetch('/api/mobile/images',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'image/jpeg','X-Bello-Mobile':'1','X-Photo-Id':photo.id},body:photo.file});
     if(!r.ok)throw Error('傷・状態写真を保存できませんでした。再度お試しください。');const v=await r.json();if(typeof v.storageKey!=='string')throw Error('写真の保存を確認できません。');uploads.current.set(photo.id,v.storageKey);
    }
    pending.current={...request(),photos:photos.map(p=>({storageKey:uploads.current.get(p.id)!,type:'DAMAGE'}))};
   }
   const result=await registerStockSplit(pending.current);
   if(result.ok){router.push('/inventory/'+result.result.splitId);router.refresh();close();return;}
   setError(result.error);setUncertain(result.code==='UNCONFIRMED');setConflict(result.code==='CONFLICT');if(result.code!=='UNCONFIRMED')pending.current=null;setReview(false);
  }catch(e){setError((e as Error).message);setUncertain(!!pending.current);setReview(false);}finally{lock.current=false;setBusy(false);}
 }
 return <InventoryOperationDialog title={review?'在庫分けの内容確認':'在庫分け'} locked={busy||uncertain} close={close} footer={<>{review&&<button type="button" disabled={busy} onClick={()=>setReview(false)} className="rounded-lg border px-5 py-3">戻る</button>}<button type="button" disabled={busy||conflict} onClick={review||uncertain?save:confirm} className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-bold text-white disabled:opacity-50">{busy?'保存を確認中…':uncertain?'保存結果を再確認':review?'保存':'内容確認'}</button></>}>
 {review?<div className="space-y-4"><p>在庫 {item.quantity}点を以下の2つの商品に分けます。</p><div className="rounded-lg bg-slate-50 p-4"><p className="text-sm text-gray-500">元の商品 · {item.quantity-Number(quantity)}点</p><p className="whitespace-pre-wrap">{sourceName}</p></div><div className="rounded-lg bg-blue-50 p-4"><p className="text-sm text-gray-500">新しい商品 · {quantity}点</p><p className="whitespace-pre-wrap">{splitName}</p></div><p>バーコード：{barcode||'未設定'} / 傷・状態写真：{photos.length}枚</p><p className="whitespace-pre-wrap">{damageNotes}</p></div>:<>
 <OperationQuantity label="分ける数量" available={item.quantity} value={quantity} onChange={setQuantity} disabled={locked}/>
 <div className="grid gap-4 sm:grid-cols-2"><label>元の商品名（残り {Math.max(0,item.quantity-(Number(quantity)||0))}点）<textarea aria-label="元の商品名" value={sourceName} onChange={e=>setSourceName(e.target.value)} className={input} rows={3} maxLength={2000} disabled={locked}/></label><label>新しい商品名（{quantity||0}点）<textarea aria-label="新しい商品名" value={splitName} onChange={e=>setSplitName(e.target.value)} className={input} rows={3} maxLength={2000} disabled={locked}/></label></div>
 <label className="block">新しい在庫の傷・汚れ・状態のメモ<textarea aria-label="傷・汚れ・状態のメモ" value={damageNotes} onChange={e=>setMemo(e.target.value)} className={input} rows={3} maxLength={10000} disabled={locked}/></label>
 <label className="block">新しい在庫のバーコード<input aria-label="バーコード" value={barcode} onChange={e=>setBarcode(e.target.value)} className={input} maxLength={256} disabled={locked}/></label><p className="text-sm text-gray-500">同じ商品のバーコードは共通で登録できます。元の商品写真・仕入情報は引き継ぎます。</p>
 <label className="block">傷・状態写真（JPEG/PNG、1枚3MBまで・20枚まで）<input type="file" accept="image/jpeg,image/png" multiple disabled={locked} className={input} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';if(files.length+photos.length>20||files.some(f=>f.size>3*1024*1024||!['image/jpeg','image/png'].includes(f.type))){setError('JPEG/PNGの画像を1枚3MB以内、合計20枚以内で選択してください。');return;}setPhotos(p=>[...p,...files.map(file=>({id:crypto.randomUUID(),file,url:URL.createObjectURL(file)}))]);}}/></label><div className="grid grid-cols-4 gap-2">{photos.map(p=><div key={p.id}><img src={p.url} alt="追加する傷・状態写真" className="aspect-square w-full rounded object-contain"/><button type="button" disabled={locked} onClick={()=>{URL.revokeObjectURL(p.url);setPhotos(v=>v.filter(x=>x.id!==p.id));}} className="w-full rounded border py-2 text-sm">選択を外す</button></div>)}</div>
 </>}{error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
 </InventoryOperationDialog>;
}

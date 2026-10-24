'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {registerSoldOut} from '@/app/actions/soldOut';
import {japanToday,SOLD_OUT_MARKETS,validateSoldOut,type SoldOutRequest} from '@/lib/inventory/soldOutInput';
interface Product {id:string;name:string;quantity:number;updatedAt:string;salePrice?:number|null;market?:string|null;externalProductId?:string|null}
export default function SoldOutButton({item}:{item:Product}) {
  const [open,setOpen]=useState(false);
  return <><button type="button" onClick={()=>setOpen(true)} disabled={item.quantity<1} className="border border-gray-300 px-3 py-1.5 text-[12px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40">売却</button>{open&&<SoldOutDialog item={item} close={()=>setOpen(false)}/>}</>;
}
function SoldOutDialog({item,close}:{item:Product;close:()=>void}) {
  const router=useRouter(),dialog=useRef<HTMLDialogElement>(null),inflight=useRef(false),pending=useRef<SoldOutRequest|null>(null);
  const [quantity,setQuantity]=useState('1'),[name,setName]=useState(item.name),[date,setDate]=useState(japanToday),[id,setId]=useState(item.externalProductId??''),[market,setMarket]=useState(item.market??''),[price,setPrice]=useState(item.salePrice==null?'':String(item.salePrice));
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState('');
  useEffect(()=>{dialog.current?.showModal();},[]);
  const locked=busy||uncertain||conflict;
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(inflight.current||conflict)return;
    setError('');
    try {
      const request=pending.current??{mutationId:crypto.randomUUID(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),name,saleEndDate:date,externalProductId:id,market,salePrice:price.trim()?Number(price):null};
      validateSoldOut(request,item.quantity,item.market??'');pending.current=request;
      inflight.current=true;setBusy(true);
      const outcome=await registerSoldOut(request);
      if(outcome.ok){router.push(`/inventory/${outcome.result.soldId}`);router.refresh();close();return;}
      setError(outcome.error);setUncertain(outcome.code==='UNCONFIRMED');setConflict(outcome.code==='CONFLICT');
      if(outcome.code!=='UNCONFIRMED')pending.current=null;
    }catch(error){setError(error instanceof Error?error.message:'登録結果を確認できません。同じ内容で再確認してください。');if(pending.current)setUncertain(true);}
    finally{inflight.current=false;setBusy(false);}
  };
  const input='mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-base disabled:bg-gray-100';
  return <dialog ref={dialog} aria-labelledby="sold-out-title" onCancel={e=>{if(busy||uncertain)e.preventDefault();else close();}} className="w-[min(540px,94vw)] rounded-xl p-0 shadow-xl backdrop:bg-black/40">
    <form onSubmit={submit} className="flex max-h-[90vh] flex-col">
      <div className="flex items-center justify-between border-b px-5 py-4"><h2 id="sold-out-title" className="text-lg font-bold">売却登録</h2><button type="button" onClick={close} disabled={busy||uncertain} className="px-3 py-2 disabled:opacity-40">キャンセル</button></div>
      <div className="space-y-4 overflow-y-auto p-5">
        <label className="block">売却数量 <span className="text-sm text-gray-500">（在庫 {item.quantity}）</span><input aria-label="売却数量" className={input} value={quantity} onChange={e=>setQuantity(e.target.value)} type="number" inputMode="numeric" min="1" max={item.quantity} step="1" required disabled={locked}/></label>
        <label className="block">商品名<textarea aria-label="商品名" className={input} rows={2} value={name} onChange={e=>setName(e.target.value)} required maxLength={2000} disabled={locked}/></label>
        <label className="block">販売終了日<input aria-label="販売終了日" className={input} type="date" value={date} onChange={e=>setDate(e.target.value)} required disabled={locked}/></label>
        <label className="block">ID<input aria-label="ID" className={input} value={id} onChange={e=>setId(e.target.value)} maxLength={256} disabled={locked}/></label>
        <label className="block">市場<select aria-label="市場" className={input} value={market} onChange={e=>setMarket(e.target.value)} disabled={locked}>{[...new Set(['',...SOLD_OUT_MARKETS,...(item.market?[item.market]:[])])].map(value=><option key={value} value={value}>{value||'未設定'}</option>)}</select></label>
        <label className="block">販売価格<input aria-label="販売価格" className={input} type="number" inputMode="numeric" value={price} onChange={e=>setPrice(e.target.value)} min="0" step="1" disabled={locked}/></label>
        <p className="text-sm text-gray-600">売却分を「売り切れ」に変更します。{Number(quantity)>0&&Number(quantity)<item.quantity?`販売中の在庫 ${item.quantity-Number(quantity)} 個を元の商品ページに残します。`:'元の商品ページを更新します。'}</p>
        {error&&<p role="alert" className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
      </div>
      <div className="border-t bg-white p-4"><button type="submit" disabled={busy||conflict} className="w-full rounded-lg bg-blue-600 px-4 py-3 font-bold text-white disabled:opacity-50">{busy?'登録を確認中…':uncertain?'登録結果を再確認':'売却登録'}</button></div>
    </form>
  </dialog>;
}

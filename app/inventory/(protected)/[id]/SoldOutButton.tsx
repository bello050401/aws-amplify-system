'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {registerSoldOut} from '@/app/actions/soldOut';
import {japanToday,SOLD_OUT_MARKETS,validateSoldOut,type SoldOutRequest} from '@/lib/inventory/soldOutInput';
import {InventoryOperationDialog,OperationQuantity,operationInput} from '@/app/inventory/InventoryOperationDialog';
interface Product {id:string;name:string;quantity:number;updatedAt:string;salePrice?:number|null;market?:string|null;externalProductId?:string|null}
export default function SoldOutButton({item}:{item:Product}) {
  const [open,setOpen]=useState(false);
  return <><button type="button" onClick={()=>setOpen(true)} disabled={item.quantity<1} className="border border-gray-300 px-3 py-1.5 text-[12px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40">売却</button>{open&&<SoldOutDialog item={item} close={()=>setOpen(false)}/>}</>;
}
function SoldOutDialog({item,close}:{item:Product;close:()=>void}) {
  const router=useRouter(),inflight=useRef(false),pending=useRef<SoldOutRequest|null>(null);
  const [quantity,setQuantity]=useState('1'),[name,setName]=useState(item.name),[date,setDate]=useState(japanToday),[id,setId]=useState(item.externalProductId??''),[market,setMarket]=useState(item.market??''),[price,setPrice]=useState(item.salePrice==null?'':String(item.salePrice));
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState('');
  const [review,setReview]=useState(false);
  const locked=busy||uncertain||conflict;
  const submit=async()=>{
    if(inflight.current||conflict)return;
    setError('');
    try {
      const request=pending.current??{mutationId:crypto.randomUUID(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),name,saleEndDate:date,externalProductId:id,market,salePrice:price.trim()?Number(price):null};
      validateSoldOut(request,item.quantity,item.market??'');pending.current=request;
      inflight.current=true;setBusy(true);
      const outcome=await registerSoldOut(request);
      if(outcome.ok){router.push(`/inventory/${outcome.result.soldId}`);router.refresh();close();return;}
      setReview(false);setError(outcome.error);setUncertain(outcome.code==='UNCONFIRMED');setConflict(outcome.code==='CONFLICT');
      if(outcome.code!=='UNCONFIRMED')pending.current=null;
    }catch(error){setError(error instanceof Error?error.message:'登録結果を確認できません。同じ内容で再確認してください。');if(pending.current)setUncertain(true);}
    finally{inflight.current=false;setBusy(false);}
  };
  const input=operationInput;
  const confirm=()=>{try{validateSoldOut({mutationId:crypto.randomUUID(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),name,saleEndDate:date,externalProductId:id,market,salePrice:price.trim()?Number(price):null},item.quantity,item.market??'');setError('');setReview(true);}catch(e){setError((e as Error).message);}};
  return <InventoryOperationDialog title={review?'売却の内容確認':'売却登録'} close={close} locked={busy||uncertain} footer={<>{review&&<button type="button" onClick={()=>setReview(false)} disabled={busy} className="rounded-lg border px-5 py-3">戻る</button>}<button type="button" disabled={busy||conflict} onClick={review||uncertain?submit:confirm} className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-bold text-white disabled:opacity-50">{busy?'登録を確認中…':uncertain?'登録結果を再確認':review?'保存':'内容確認'}</button></>}>
    {review?<div className="space-y-3"><p className="font-semibold">{name}</p><p>売却 {quantity}点 / 残り {item.quantity-Number(quantity)}点</p><p>販売終了日：{date}</p><p>市場：{market||'未設定'}</p><p>販売価格：{price||'未設定'}円</p></div>:<>
        <OperationQuantity label="売却数量" available={item.quantity} value={quantity} onChange={setQuantity} disabled={locked}/>
        <label className="block">商品名<textarea aria-label="商品名" className={input} rows={2} value={name} onChange={e=>setName(e.target.value)} required maxLength={2000} disabled={locked}/></label>
        <label className="block">販売終了日<input aria-label="販売終了日" className={input} type="date" value={date} onChange={e=>setDate(e.target.value)} required disabled={locked}/></label>
        <label className="block">ID<input aria-label="ID" className={input} value={id} onChange={e=>setId(e.target.value)} maxLength={256} disabled={locked}/></label>
        <label className="block">市場<select aria-label="市場" className={input} value={market} onChange={e=>setMarket(e.target.value)} disabled={locked}>{[...new Set(['',...SOLD_OUT_MARKETS,...(item.market?[item.market]:[])])].map(value=><option key={value} value={value}>{value||'未設定'}</option>)}</select></label>
        <label className="block">販売価格<input aria-label="販売価格" className={input} type="number" inputMode="numeric" value={price} onChange={e=>setPrice(e.target.value)} min="0" step="1" disabled={locked}/></label>
        <p className="text-sm text-gray-600">売却分を「売り切れ」に変更します。{Number(quantity)>0&&Number(quantity)<item.quantity?`販売中の在庫 ${item.quantity-Number(quantity)} 個を元の商品ページに残します。`:'元の商品ページを更新します。'}</p>
    </>}{error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
  </InventoryOperationDialog>;
}

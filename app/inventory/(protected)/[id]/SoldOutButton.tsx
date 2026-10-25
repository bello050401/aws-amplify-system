'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {registerSoldOut} from '@/app/actions/soldOut';
import {SaleRegistrationForm,type SaleProduct} from '@/components/sales/SaleRegistrationForm';
import {InventoryOperationDialog} from '@/app/inventory/InventoryOperationDialog';
export default function SoldOutButton({item}:{item:SaleProduct}){
 const [open,setOpen]=useState(false),[locked,setLocked]=useState(false);const router=useRouter();
 return <><button type="button" onClick={()=>setOpen(true)} disabled={item.quantity<1} className="border border-gray-300 px-3 py-1.5 text-[12px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40">売却</button>{open&&<InventoryOperationDialog title="売却登録" close={()=>setOpen(false)} locked={locked} footer={null}><SaleRegistrationForm item={item} save={registerSoldOut} onLocked={setLocked} onCancel={()=>setOpen(false)} onComplete={r=>{router.push('/inventory/'+r.soldId);router.refresh();setOpen(false);}}/></InventoryOperationDialog>}</>;
}

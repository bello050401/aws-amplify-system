'use client';
import {useEffect,useRef,type ReactNode} from 'react';
export const operationInput='mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base disabled:bg-gray-100';
export function InventoryOperationDialog({title,children,footer,close,locked=false}:{title:string;children:ReactNode;footer:ReactNode;close:()=>void;locked?:boolean}) {
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog ref={ref} aria-label={title} onCancel={e=>{if(locked)e.preventDefault();else close();}} className="w-[min(680px,94vw)] rounded-xl p-0 shadow-xl backdrop:bg-black/40"><div className="flex max-h-[90dvh] flex-col"><header className="flex items-center justify-between border-b px-5 py-4"><h2 className="text-lg font-bold">{title}</h2><button type="button" onClick={close} disabled={locked} className="rounded px-3 py-2 disabled:opacity-40">キャンセル</button></header><div className="space-y-4 overflow-y-auto p-5">{children}</div><footer className="flex gap-3 border-t bg-white p-4">{footer}</footer></div></dialog>;
}
export function OperationQuantity({label,available,value,onChange,disabled=false}:{label:string;available:number;value:string;onChange:(value:string)=>void;disabled?:boolean}) {
 const step=(delta:number)=>onChange(String(Math.max(1,Math.min(available,(Number(value)||1)+delta))));
 return <div><label className="block">{label}<span className="ml-2 text-sm text-gray-500">在庫 {available}点</span></label><div className="mt-2 flex max-w-xs items-center gap-2"><button type="button" aria-label={label+'を1減らす'} disabled={disabled||Number(value)<=1} onClick={()=>step(-1)} className="h-11 w-11 rounded-lg border disabled:opacity-40">−</button><input aria-label={label} className={operationInput+' !mt-0 min-w-0 flex-1 text-center'} type="number" inputMode="numeric" min={1} max={available} step={1} value={value} onChange={e=>onChange(e.target.value)} disabled={disabled}/><button type="button" aria-label={label+'を1増やす'} disabled={disabled||Number(value)>=available} onClick={()=>step(1)} className="h-11 w-11 rounded-lg border disabled:opacity-40">＋</button></div></div>;
}

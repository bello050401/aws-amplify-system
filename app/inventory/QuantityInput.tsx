'use client';
export function QuantityInput({value,onChange}:{value:string;onChange:(value:string)=>void}) {
 const step=(delta:number)=>onChange(String(Math.max(0,Math.min(2147483647,(Number(value)||0)+delta))));
 return <label className="block text-sm text-gray-600">数量<div className="mt-1 flex overflow-hidden rounded border border-gray-300"><button type="button" aria-label="数量を1減らす" onClick={()=>step(-1)} disabled={Number(value)<=0} className="min-h-11 w-11 bg-gray-50 text-xl disabled:opacity-30">−</button><input aria-label="数量" type="number" min="0" max="2147483647" step="1" value={value} onChange={e=>onChange(e.target.value)} className="min-h-11 min-w-0 w-full border-x px-3 text-base text-gray-900"/><button type="button" aria-label="数量を1増やす" onClick={()=>step(1)} className="min-h-11 w-11 bg-gray-50 text-xl">＋</button></div></label>;
}

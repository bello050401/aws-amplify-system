'use client';
export function CategoryMultiSelect({value,onChange,options}:{value:string[];onChange:(ids:string[])=>void;options:{id:string;name:string}[]}){
 return <fieldset className="space-y-2"><legend className="mb-2 font-medium">カテゴリ（複数選択）</legend><div className="flex flex-wrap gap-2">{options.map(option=><label key={option.id} className={'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 '+(value.includes(option.id)?'border-blue-500 bg-blue-50':'border-gray-300')}><input type="checkbox" checked={value.includes(option.id)} onChange={e=>onChange(e.target.checked?[...value,option.id]:value.filter(id=>id!==option.id))}/>{option.name}</label>)}</div></fieldset>;
}

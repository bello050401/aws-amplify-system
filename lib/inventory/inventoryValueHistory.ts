import {buildInventoryValue,type InventoryValue,type ValueSource} from './inventoryValue';
import {mapZaicoOptionalAttributes} from './zaicoMapping';
import {splitCategoryNames} from './categories';

export interface ArchivedStock {
  id:number;title?:string;quantity:string|number|null;category?:string|null;
  optional_attributes:Record<string,string|null>|null;deleted:boolean;updated_at:string;
}
export interface InventoryWindow {key:string;end:string;start?:string;full:boolean;remote:ArchivedStock[]}
import {monthEndBoundary} from './inventoryValueCalendar';
export {monthEndBoundary,lastClosedInventoryMonth,inventoryMonthOptions} from './inventoryValueCalendar';

/** Restore actual recorded quantities; never substitute today's quantity or original lot quantity. */
export function reconstructMonthEnd(windows:InventoryWindow[],month:string,links:Map<string,{id:string;sku?:string|null}>=new Map()):{value:InventoryValue;keys:string[];recordCount:number} {
  const cutoff=Date.parse(monthEndBoundary(month));
  const sorted=[...windows].sort((a,b)=>Date.parse(a.end)-Date.parse(b.end));
  const full=sorted.filter(w=>w.full&&Date.parse(w.end)<cutoff).at(-1);
  if(!full)throw Error('月末以前の全件記録がありません');
  let covered=Date.parse(full.end);const rows=new Map<string,ArchivedStock>();const keys=[full.key];
  for(const row of full.remote){if(rows.has(String(row.id)))throw Error('全件記録に重複があります');rows.set(String(row.id),row);}
  for(const w of sorted){
    if(Date.parse(w.end)<=covered)continue;
    if(covered>=cutoff)break;
    if(w.full||!w.start||Date.parse(w.start)>covered)throw Error('月末までの更新記録が連続していません');
    for(const row of w.remote){
      const updated=Date.parse(row.updated_at);
      if(!Number.isFinite(updated))throw Error('更新日時を確認できない商品があります');
      // The crossing window can include multiple edits straddling midnight. Do not guess its previous value.
      if(updated>=cutoff)throw Error('月末をまたぐ更新があります。直前記録の確認が必要です');
      rows.set(String(row.id),row);
    }
    covered=Date.parse(w.end);keys.push(w.key);
  }
  if(covered<cutoff)throw Error('月末までの更新記録が不足しています');
  const categories=new Set<string>();const source:ValueSource[]=[];
  for(const row of rows.values()){
    if(row.deleted)continue;
    const labels=splitCategoryNames(row.category??'');labels.forEach(n=>categories.add(n));
    const attributes=Object.entries(row.optional_attributes??{}).map(([name,value])=>({name,value}));
    const mapped=mapZaicoOptionalAttributes(attributes,true);
    const q=row.quantity===null||String(row.quantity).trim()===''?0:Number(String(row.quantity).normalize('NFKC').replace(/,/g,''));
    const link=links.get(String(row.id));
    source.push({id:link?.id??`zaico:${row.id}`,sku:link?.sku??String(row.id),name:row.title,quantity:q,
      purchasePrice:mapped.coreFields.purchasePrice??null,saleEndDate:mapped.extendedFields.saleEndDate,categoryIds:labels});
  }
  const value=buildInventoryValue(source,[...categories].map(name=>({id:name,name})),new Date(cutoff-1).toISOString());
  value.month=month;
  value.source='月末直前の全件記録と、月末までの更新記録から復元';
  return {value,keys,recordCount:source.length};
}

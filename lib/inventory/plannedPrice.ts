import {inventoryCategoryIds,type CategoryRecord} from './categories';

export const PRICE_ENTRY_CATEGORIES=['補修待ち','撮影待ち','出品待ち'] as const;
export interface PriceEntryItem {id:string;sku:string;name:string;note:string;plannedSalePrice:number|null;updatedAt:string;imageUrl:string|null}
export interface PriceEntryChange {id:string;expectedUpdatedAt:string;mutationId:string;name:string;note:string;plannedSalePrice:number|null}
export function priceEntryCategoryIds(categories:readonly {id:string;name:string}[]){return categories.filter(c=>(PRICE_ENTRY_CATEGORIES as readonly string[]).includes(c.name)).map(c=>c.id);}
export function isPriceEntryTarget(row:CategoryRecord & {plannedSalePrice?:unknown;deletedAt?:unknown;listingPartition?:unknown},ids:readonly string[]){
 return !row.deletedAt&&row.listingPartition!=='MERGED'&&(row.plannedSalePrice==null||row.plannedSalePrice==='')&&inventoryCategoryIds(row).some(id=>ids.includes(id));
}
export function parsePriceEntryChange(raw:unknown):PriceEntryChange{
 const invalid=(message:string)=>Object.assign(Error(message),{code:'INVALID_INPUT'});
 const r=raw as PriceEntryChange;
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['id','expectedUpdatedAt','mutationId','name','note','plannedSalePrice'].includes(k))||
 !/^[a-f0-9-]{36}$/i.test(r.id)||!/^[a-f0-9-]{36}$/i.test(r.mutationId)||typeof r.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(r.expectedUpdatedAt)))throw invalid('保存内容を確認してください。');
 if(typeof r.name!=='string'||!r.name.trim()||r.name.length>16000)throw invalid('商品名を入力してください。');
 if(typeof r.note!=='string'||r.note.length>16000)throw invalid('備考は16,000文字以内で入力してください。');
 if(r.plannedSalePrice!==null&&(!Number.isSafeInteger(r.plannedSalePrice)||r.plannedSalePrice<0||r.plannedSalePrice>2147483647))throw invalid('販売予定価格は0〜2,147,483,647円の整数で入力してください。');
 return {...r,name:r.name.trim()};
}

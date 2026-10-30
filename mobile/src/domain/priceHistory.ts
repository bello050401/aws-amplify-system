import type {InventoryItem, InventoryThumbnail} from './inventory';
import type {InventorySearchInput} from './search';
import type {MobileFeatures} from './access';
import {splitCategoryNames} from '../../../lib/inventory/categories';
import {visibleDetailFields, type DetailField} from './detailFields';

export interface PriceHistoryPage {items:InventoryItem[];hasMore:boolean;nextOffset?:number;total?:number|null}
export interface PriceHistoryPorts {
  features:MobileFeatures;
  search:(query:string,offset:number)=>Promise<PriceHistoryPage>;
  detail:(id:string)=>Promise<InventoryItem>;
  thumbnails?:(ids:string[])=>Promise<InventoryThumbnail[]>;
}
export const isShippedInventory=(item:InventoryItem)=>splitCategoryNames(item.category).includes('発送完了')&&!item.mergedIntoInventoryId;
// Brackets are internal notes; changing this search text never changes either product name.
export const priceHistoryQuery=(name:string)=>name.replace(/【[^】]*】/g,' ').replace(/\s+/g,' ').trim().slice(0,200);
export function priceHistorySearch(query:string,offset=0):InventorySearchInput {
  return {q:query.trim().slice(0,200),category:'発送完了',offset,sort:{field:'updatedAt',direction:'desc'},advanced:{combinator:'AND',conditions:[]}};
}
export const priceHistoryFields=(features:MobileFeatures)=>visibleDetailFields(features).filter(field=>field.section==='販売情報');
export function priceHistoryValue(field:DetailField,value:string|undefined){
  if(!value?.trim())return '未入力';
  if(field.kind==='money'&&/^\d+(\.\d+)?$/.test(value.trim()))return `¥${Number(value).toLocaleString('ja-JP')}`;
  if(field.kind==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(value))return value.replaceAll('-','/');
  return value;
}

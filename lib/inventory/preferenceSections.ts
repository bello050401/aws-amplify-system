import {sanitizeInventoryView,INVENTORY_VIEW_KEY} from './viewPreferences';
import {INVENTORY_LIST_COLUMNS_STORAGE_KEY} from './listColumns';
export const preferenceSections={view:{key:INVENTORY_VIEW_KEY,event:'bello:inventory-view-changed'},columns:{key:INVENTORY_LIST_COLUMNS_STORAGE_KEY,event:'inventory-columns-changed'},density:{key:'bello-inventory-list-density',event:'inventory-list-density'},searches:{key:'bello-inventory-saved-searches-v1',event:'inventory-saved-searches-changed'}} as const;
export type PreferenceSection=keyof typeof preferenceSections;
export function sanitizePreference(section:PreferenceSection,value:unknown):unknown {
 if(!Object.hasOwn(preferenceSections,section))throw Error('設定の種類を確認してください。');
 if(JSON.stringify(value)?.length>180000)throw Error('設定の容量が大きすぎます。');
 if(section==='view')return sanitizeInventoryView(value);
 if(section==='density')return value==='compact'?'compact':'normal';
 if(section==='searches'){
  if(!Array.isArray(value)||value.length>10)throw Error('検索条件は10件以内で保存してください。');
  return value.map(v=>{if(!v||typeof v.id!=='string'||typeof v.name!=='string'||typeof v.query!=='string'||v.id.length>128||v.name.length>60||v.query.length>12000)throw Error('検索条件を確認してください。');return {id:v.id,name:v.name,query:v.query};});
 }
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('表示項目を確認してください。');
 const v=value as Record<string,unknown>,keys=(x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.entries(x).filter(([k])=>k.length<200&&k!=='__proto__').slice(0,500):[];
 return {visibility:{...Object.fromEntries(keys(v.visibility).filter(([,x])=>typeof x==='boolean')),name:true},order:Array.isArray(v.order)?[...new Set(v.order.filter(x=>typeof x==='string'&&x.length<200))].slice(0,500):[],widths:Object.fromEntries(keys(v.widths).filter(([,x])=>typeof x==='number'&&Number.isFinite(x)&&x>=30&&x<=3000))};
}

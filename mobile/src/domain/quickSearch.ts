import type {InventorySearchInput,SearchFieldDef} from './search';
import type {InventoryItem} from './inventory';
import {inventoryComparator} from '../../../lib/inventory/searchSort';
import {splitCategoryNames} from '../../../lib/inventory/categories';
import {applyCatalogDelta,catalogBucket,compactCatalogItem,CATALOG_BUCKETS,CATALOG_RETENTION_MS,CATALOG_SYNC_MS,type CatalogDelta,type CatalogState} from './catalogProtocol';

export const QUICK_SEARCH_MAX_AGE=CATALOG_RETENTION_MS;
const supported=new Set(['updatedAt','createdAt','name','locationId','quantity','barcode','plannedSalePrice','sku','displayId','statusId','unit']);
export function supportsQuickSearch(input:InventorySearchInput){
 const conditions=input.advanced?.conditions??[];
 return supported.has(input.sort?.field??'updatedAt')&&conditions.every(c=>c.field==='barcode'&&c.operator==='equals'&&typeof c.value==='string');
}
const normalize=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('ja');
type Entry={item:InventoryItem;name:string;barcode:string;categories:string[];record:Record<string,unknown>};
export class QuickSearchCatalog {
 private items:InventoryItem[]=[];
 private fetchedAt=0;
 private revision=0;
 private hashes=Array<string>(CATALOG_BUCKETS).fill('');
 private indexed:Entry[]|null=null;
 private indexedFields:SearchFieldDef[]|null=null;
 private sorted:{key:string;entries:Entry[]}|null=null;
 private result:{key:string;items:InventoryItem[];quantity:number}|null=null;
 version(){return this.revision;}
 ready(now=Date.now()){return this.fetchedAt>0&&now-this.fetchedAt<QUICK_SEARCH_MAX_AGE;}
 needsSync(now=Date.now()){return !this.ready(now)||now-this.fetchedAt>=CATALOG_SYNC_MS||this.hashes.some(h=>!h);}
 manifest(){return this.ready()?[...this.hashes]:undefined;}
 state():CatalogState|null{return this.fetchedAt?{schema:2,hashes:[...this.hashes],items:this.items,checkedAt:new Date(this.fetchedAt).toISOString()}:null;}
 private invalidate(){this.indexed=null;this.sorted=null;this.result=null;}
 restore(state:CatalogState,startedRevision:number){
  if(startedRevision!==this.revision||this.fetchedAt)return false;
  this.items=state.items.map(compactCatalogItem);this.hashes=state.hashes;this.fetchedAt=Date.parse(state.checkedAt);this.invalidate();return true;
 }
 accept(delta:CatalogDelta,startedRevision:number){
  if(startedRevision!==this.revision)return false;
  const next=applyCatalogDelta(this.state(),delta);
  this.items=next.items;this.hashes=next.hashes;this.fetchedAt=Date.parse(next.checkedAt);
  if(delta.buckets.length)this.invalidate();
  return true;
 }
 replace(items:InventoryItem[],startedRevision:number,now=Date.now()){
  if(startedRevision!==this.revision)return false;
  this.items=items.map(compactCatalogItem);this.fetchedAt=now;this.hashes.fill('');this.invalidate();return true;
 }
 clear(){this.items=[];this.fetchedAt=0;this.hashes.fill('');this.revision++;this.invalidate();}
 reconcile(cached:InventoryItem[]):InventoryItem[]{
  if(!this.ready())return cached;
  const current=new Map(this.items.map(i=>[i.id,i]));
  return cached.flatMap(i=>{const row=current.get(i.id);return !row?[]:[row.updatedAt===i.updatedAt?i:row];});
 }
 update(changed:InventoryItem[],deletedIds:string[]=[]){
  this.revision++;const updates=new Map(changed.map(i=>[i.id,i])),deleted=new Set(deletedIds);
  for(const id of [...updates.keys(),...deleted])this.hashes[catalogBucket(id)]='';
  this.items=[...changed.filter(i=>!deleted.has(i.id)).map(compactCatalogItem),...this.items.filter(i=>!updates.has(i.id)&&!deleted.has(i.id))];
  this.invalidate();
 }
 /** Opening an unchanged detail is not an edit. Keep the search index and
  * delta hashes intact instead of synchronizing the same bucket on every back. */
 observe(item:InventoryItem){
  const current=this.items.find(row=>row.id===item.id),compact=compactCatalogItem(item);
  if(current&&JSON.stringify(compactCatalogItem(current))===JSON.stringify(compact))return false;
  this.update([item]);return true;
 }
 search(input:InventorySearchInput,fields:SearchFieldDef[],now=Date.now()){
  if(!this.ready(now)||!supportsQuickSearch(input))return null;
  if(!this.indexed||this.indexedFields!==fields){
   this.indexedFields=fields;
   const defs=new Map(fields.map(f=>[f.key,f]));
   const master=(key:string,label:string)=>defs.get(key)?.options?.find(o=>o.label===label)?.value??label;
   this.indexed=this.items.map(item=>({item,name:normalize(item.name),barcode:normalize(item.barcode),categories:splitCategoryNames(item.category),
    record:{...item,sourceInventoryId:item.displayId&&/^\d+$/.test(item.displayId)?item.displayId:undefined,locationId:master('locationId',item.location),statusId:item.statusId??master('statusId',item.condition)}}));
   this.sorted=null;this.result=null;
  }
  const sort=input.sort??{field:'updatedAt',direction:'desc' as const},sortKey=JSON.stringify(sort);
  if(this.sorted?.key!==sortKey){
   const compare=inventoryComparator(sort,new Map(fields.map(f=>[f.key,f])));
   this.sorted={key:sortKey,entries:[...this.indexed].sort((a,b)=>compare(a.record,b.record))};this.result=null;
  }
  const key=JSON.stringify([input.q,input.category,input.advanced,sort]);
  if(this.result?.key!==key){
   const needle=normalize(input.q?.trim()??''),conditions=input.advanced?.conditions??[],codes=conditions.map(c=>normalize(c.value??''));
   const found=this.sorted.entries.filter(e=>(!needle||e.name.includes(needle))&&(!input.category||e.categories.includes(input.category))&&
    (!codes.length||(input.advanced?.combinator==='OR'?codes.some(c=>e.barcode===c):codes.every(c=>e.barcode===c)))).map(e=>e.item);
   this.result={key,items:found,quantity:found.reduce((sum,r)=>sum+r.quantity,0)};
  }
  const all=this.result.items,offset=input.offset??0;
  return {items:all.slice(offset,offset+50),imagesDeferred:true,hasMore:offset+50<all.length,nextOffset:offset+50,total:all.length,totalQuantity:this.result.quantity};
 }
}

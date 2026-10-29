import {cachedInventorySearch,type InventorySearchInput,type SearchFieldDef} from './search';
import type {InventoryItem} from './inventory';
export const QUICK_SEARCH_MAX_AGE=60000;
// Category sorting uses the server's primary category ID, not a joined display label.
const supported=new Set(['updatedAt','createdAt','name','locationId','quantity','barcode','plannedSalePrice','sku','displayId','statusId','unit']);
/** Unknown detail fields must always use the full server search. */
export function supportsQuickSearch(input:InventorySearchInput){
 return !!(input.q?.trim()||input.category)&&!input.advanced?.conditions.length&&supported.has(input.sort?.field??'updatedAt');
}
export class QuickSearchCatalog {
 private items:InventoryItem[]=[];
 private fetchedAt=0;
 private revision=0;
 version(){return this.revision;}
 ready(now=Date.now()){return this.fetchedAt>0&&now-this.fetchedAt<QUICK_SEARCH_MAX_AGE;}
 replace(items:InventoryItem[],startedRevision:number,now=Date.now()){
  // A fetch begun before a save/delete cannot resurrect or overwrite that edit.
  if(startedRevision!==this.revision)return false;
  this.items=items;this.fetchedAt=now;return true;
 }
 clear(){this.items=[];this.fetchedAt=0;this.revision++;}
 update(changed:InventoryItem[],deletedIds:string[]=[]){
  this.revision++;const updates=new Map(changed.map(i=>[i.id,i])),deleted=new Set(deletedIds);
  this.items=[...changed.filter(i=>!deleted.has(i.id)),...this.items.filter(i=>!updates.has(i.id)&&!deleted.has(i.id))];
 }
 search(input:InventorySearchInput,fields:SearchFieldDef[],now=Date.now()){
  if(!this.ready(now)||!supportsQuickSearch(input))return null;
  const all=cachedInventorySearch(this.items,input,fields),offset=input.offset??0;
  return {items:all.slice(offset,offset+50),imagesDeferred:true,hasMore:offset+50<all.length,nextOffset:offset+50,total:all.length,totalQuantity:all.reduce((sum,r)=>sum+r.quantity,0)};
 }
}

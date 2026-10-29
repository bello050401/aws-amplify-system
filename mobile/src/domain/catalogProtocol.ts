import type {InventoryItem} from './inventory';
import {isInventoryItem} from './snapshot';

export const CATALOG_SCHEMA = 2;
export const CATALOG_BUCKETS = 64;
export const CATALOG_MAX_ITEMS = 20000;
export const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const CATALOG_RETENTION_MS = 30 * 86400000;
export const CATALOG_SYNC_MS = 60000;
export interface CatalogState {schema:2; hashes:string[]; items:InventoryItem[]; checkedAt:string}
export interface CatalogDelta {schema:2; hashes:string[]; buckets:{index:number;items:InventoryItem[]}[]; checkedAt:string; total:number}

/** Stable partitions make deletion/replacement detectable without a growing tombstone log. */
export function catalogBucket(id:string) {
 let hash=2166136261;
 for(let n=0;n<id.length;n++)hash=Math.imul(hash^id.charCodeAt(n),16777619);
 return (hash>>>0)%CATALOG_BUCKETS;
}
/** Never persist details, notes, customer/sales information, photographs or signed URLs here. */
export function compactCatalogItem(i:InventoryItem):InventoryItem {
 return {id:i.id,sku:i.sku,displayId:i.displayId,name:i.name,quantity:i.quantity,quantityUnset:i.quantityUnset,
  unit:i.unit,location:i.location,category:i.category,condition:i.condition,statusId:i.statusId,
  barcode:i.barcode,plannedSalePrice:i.plannedSalePrice,createdAt:i.createdAt,updatedAt:i.updatedAt,listUpdatedAt:i.listUpdatedAt,
  note:'',thumbnailUrl:null};
}
export function validCatalogHashes(value:unknown):value is string[] {
 return Array.isArray(value)&&value.length===CATALOG_BUCKETS&&value.every(v=>typeof v==='string'&&/^(?:[a-f0-9]{32})?$/.test(v));
}
export function validateCatalogState(value:unknown,now=Date.now()):value is CatalogState {
 const s=value as CatalogState|undefined;
 return !!s&&s.schema===CATALOG_SCHEMA&&validCatalogHashes(s.hashes)&&Array.isArray(s.items)&&s.items.length<=CATALOG_MAX_ITEMS&&s.items.every(isInventoryItem)&&
  new Set(s.items.map(i=>i.id)).size===s.items.length&&Number.isFinite(Date.parse(s.checkedAt))&&Date.parse(s.checkedAt)<=now+60000&&now-Date.parse(s.checkedAt)<CATALOG_RETENTION_MS;
}
/** Validate the entire response before making any change. A partial response is never a full catalogue. */
export function applyCatalogDelta(previous:CatalogState|null,delta:CatalogDelta):CatalogState {
 if(delta?.schema!==CATALOG_SCHEMA||!validCatalogHashes(delta.hashes)||delta.hashes.some(h=>!h)||!Array.isArray(delta.buckets)||delta.buckets.length>CATALOG_BUCKETS||
  !Number.isInteger(delta.total)||delta.total<0||delta.total>CATALOG_MAX_ITEMS||!Number.isFinite(Date.parse(delta.checkedAt)))throw Error('INVALID_CATALOG');
 const changed=new Map<number,InventoryItem[]>();
 for(const bucket of delta.buckets){
  if(!Number.isInteger(bucket.index)||bucket.index<0||bucket.index>=CATALOG_BUCKETS||changed.has(bucket.index)||!Array.isArray(bucket.items)||bucket.items.length>CATALOG_MAX_ITEMS||
   !bucket.items.every(item=>isInventoryItem(item)&&catalogBucket(item.id)===bucket.index))throw Error('INVALID_CATALOG_BUCKET');
  changed.set(bucket.index,bucket.items.map(compactCatalogItem));
 }
 for(let index=0;index<CATALOG_BUCKETS;index++)if((!previous||previous.hashes[index]!==delta.hashes[index])&&!changed.has(index))throw Error('INCOMPLETE_CATALOG');
 const items=[...(previous?.items??[]).filter(i=>!changed.has(catalogBucket(i.id))),...[...changed.values()].flat()];
 if(items.length!==delta.total||new Set(items.map(i=>i.id)).size!==items.length)throw Error('INCOMPLETE_CATALOG');
 const result:CatalogState={schema:2,hashes:[...delta.hashes],items,checkedAt:delta.checkedAt};
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>CATALOG_MAX_BYTES)throw Error('CATALOG_LIMIT');
 return result;
}

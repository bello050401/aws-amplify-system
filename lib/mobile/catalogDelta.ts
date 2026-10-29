import {createHash} from 'node:crypto';
import {catalogBucket,CATALOG_BUCKETS,CATALOG_MAX_ITEMS,CATALOG_MAX_BYTES,compactCatalogItem,type CatalogDelta} from '@/mobile/src/domain/catalogProtocol';
import type {InventoryItem} from '@/mobile/src/domain/inventory';

export function buildCatalogDelta(items:InventoryItem[],previous:string[]|undefined,checkedAt:string):CatalogDelta {
 if(items.length>CATALOG_MAX_ITEMS)throw Error('CATALOG_LIMIT');
 const buckets=Array.from({length:CATALOG_BUCKETS},()=>[] as InventoryItem[]);
 for(const item of items)buckets[catalogBucket(item.id)].push(compactCatalogItem(item));
 for(const rows of buckets)rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const serialized=buckets.map(rows=>JSON.stringify(rows));
 if(serialized.reduce((n,s)=>n+Buffer.byteLength(s),0)>CATALOG_MAX_BYTES-10000)throw Error('CATALOG_LIMIT');
 const hashes=serialized.map(json=>createHash('sha256').update(json).digest('hex').slice(0,32));
 return {schema:2,hashes,checkedAt,total:items.length,buckets:buckets.flatMap((rows,index)=>previous?.[index]===hashes[index]?[]:[{index,items:rows}])};
}

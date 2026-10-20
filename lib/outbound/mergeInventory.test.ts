import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesOutboundMerge,mergeQuantities,mergedSourceCustom,mergedInventoryTarget} from './mergeInventory';
import {syncOneZaicoItem} from '@/lib/inventory/zaicoSyncEngine';
import type {ZaicoSyncPort} from '@/lib/inventory/zaicoSyncPorts';
const source={id:'source',barcode:'001234',name:'テスト 椅子',quantity:2,locationId:'original',customFields:JSON.stringify({material:'wood'})};
const target={...source,id:'target',quantity:3,locationId:'kawagoe',images:['different'],plannedSalePrice:9000,note:'別の内容',customFields:'{}'};
test('barcode and exact title alone identify destination stock, independent of lineage/photos/prices',()=>{
 assert.equal(matchesOutboundMerge(source,target,'kawagoe'),true);
 for(const change of [{barcode:'01234'},{name:'テスト椅子'},{locationId:'other'},{id:'source'},{deletedAt:'today'},{listingPartition:'MERGED'}])assert.equal(matchesOutboundMerge(source,{...target,...change},'kawagoe'),false);
 assert.equal(matchesOutboundMerge({...source,barcode:''},{...target,barcode:''},'kawagoe'),false);
});
test('movement conserves total quantity and rejects invalid GraphQL integer totals',()=>{
 assert.deepEqual(mergeQuantities(source,target,2),{remaining:0,before:3,after:5});
 assert.deepEqual(mergeQuantities(source,target,1),{remaining:1,before:3,after:4});
 for(const moved of [0,-1,3,1.2,NaN])assert.throws(()=>mergeQuantities(source,target,moved));
 assert.throws(()=>mergeQuantities(source,{...target,quantity:2_147_483_647},1));
});
test('merged source retains business fields, records destination, and protects zero quantity',()=>{
 const custom=mergedSourceCustom(source,{quantity:0},'target','batch','now');
 assert.equal(mergedInventoryTarget(custom),'target');
 const parsed=JSON.parse(custom!);assert.equal(parsed.material,'wood');assert.ok(parsed.__belloEditedFields.includes('quantity'));
 assert.equal(mergedInventoryTarget('{}'),null);
});
test('ZAICO sync retains consolidated source link without recreating stock or importing photos',async()=>{
 const existing={...source,sku:'B1',customFields:mergedSourceCustom(source,{quantity:0},'target','batch','now')};
 const port=new Proxy({findExistingBySourceId:async()=>existing},{get(obj,key){if(key in obj)return obj[key as keyof typeof obj];return ()=>{throw Error('Unexpected sync side effect: '+String(key));};}}) as unknown as ZaicoSyncPort;
 const result=await syncOneZaicoItem({id:123,title:source.name,quantity:5} as Parameters<typeof syncOneZaicoItem>[0],'test',undefined,port);
 assert.equal(result.status,'unchanged');assert.equal(result.inventoryId,'source');
});

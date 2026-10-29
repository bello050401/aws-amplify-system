import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isPriceEntryTarget,parsePriceEntryChange,priceEntryCategoryIds} from '../lib/inventory/plannedPrice';
import {savePlannedPrice,type PriceEntryPort} from '../lib/inventory/plannedPriceCore';
import {InventorySaveError} from '../lib/inventory/conditionalUpdate';
async function main(){
const categories=[{id:'r',name:'補修待ち'},{id:'p',name:'撮影待ち'},{id:'l',name:'出品待ち'},{id:'s',name:'販売中'}];
const ids=priceEntryCategoryIds(categories);assert.deepEqual(ids,['r','p','l']);
for(const c of ids){assert.equal(isPriceEntryTarget({categoryId:c},ids),true);assert.equal(isPriceEntryTarget({categoryIds:['s',c],plannedSalePrice:null},ids),true);}
for(const row of [{categoryId:'s'},{categoryIds:['r'],plannedSalePrice:0},{categoryIds:['r'],plannedSalePrice:100},{categoryIds:['r'],deletedAt:'deleted'},{categoryIds:['r'],listingPartition:'MERGED'}])assert.equal(isPriceEntryTarget(row,ids),false);
let row:any={id:randomUUID(),name:'椅子',note:'旧備考',quantity:5,categoryIds:['r'],locationId:'office',barcode:'123',plannedSalePrice:null,updatedAt:'2026-10-29T00:00:00.000Z',customFields:JSON.stringify({keep:'retained'})},writes=0,mode='ok';
const original=structuredClone(row),input={id:row.id,mutationId:randomUUID(),expectedUpdatedAt:row.updatedAt,name:'椅子（価格確認済）',note:'脚を確認',plannedSalePrice:32000};
const port:PriceEntryPort={get:async()=>structuredClone(row),categories:async()=>categories,save:async(before,patch)=>{if(mode==='before')throw new InventorySaveError('UNCONFIRMED');if(mode==='conflict'){row.updatedAt='2026-10-29T00:00:01.000Z';throw new InventorySaveError('CONFLICT');}assert.equal(before.updatedAt,row.updatedAt);row={...row,...patch};writes++;if(mode==='after')throw new InventorySaveError('UNCONFIRMED');}};
for(const invalid of [{plannedSalePrice:-1},{plannedSalePrice:1.2},{plannedSalePrice:'1000'},{name:''},{quantity:3}])assert.throws(()=>parsePriceEntryChange({...input,...invalid}));
await savePlannedPrice(port,input,'staff');assert.equal(row.plannedSalePrice,32000);assert.equal(row.name,input.name);assert.equal(row.note,input.note);for(const k of ['quantity','categoryIds','locationId','barcode'])assert.deepEqual(row[k],original[k]);assert.equal(JSON.parse(row.customFields).keep,'retained');assert.ok(row.updatedAt>original.updatedAt);
await savePlannedPrice(port,input,'staff');assert.equal(writes,1,'retry must not repeat write');
await assert.rejects(()=>savePlannedPrice(port,{...input,mutationId:randomUUID()},'staff'),/別の端末/);
row=structuredClone(original);mode='before';await assert.rejects(()=>savePlannedPrice(port,input,'staff'));assert.deepEqual(row,original);
mode='after';await savePlannedPrice(port,input,'staff');assert.equal(row.plannedSalePrice,32000);assert.equal(writes,2);
row={...original,outboundBatchId:'reserved'};await assert.rejects(()=>savePlannedPrice(port,input,'staff'),/出庫/);
row={...original,categoryIds:['s']};await assert.rejects(()=>savePlannedPrice(port,input,'staff'),/別の端末/);
row=structuredClone(original);mode='ok';await savePlannedPrice(port,{...input,name:row.name,note:row.note,plannedSalePrice:null},'staff');assert.equal(writes,2,'no change must not write');
mode='conflict';await assert.rejects(()=>savePlannedPrice(port,input,'staff'),/別の端末/);assert.equal(row.plannedSalePrice,null);
row=structuredClone(original);mode='ok';await savePlannedPrice(port,{...input,plannedSalePrice:0},'staff');assert.equal(row.plannedSalePrice,0);
console.log('PASS: category/missing-price selection, zero, allowed fields, no-op, atomic save contract, conflict, retry after lost response, failure before save, outbound reservation, preserved unrelated data.');

} main().catch(e=>{console.error(e);process.exitCode=1;});
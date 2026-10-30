import {test} from 'node:test';
import assert from 'node:assert/strict';
import {priceHistorySearch,priceHistoryQuery,isShippedInventory,priceHistoryFields,priceHistoryValue} from '../src/domain/priceHistory';
import {QuickSearchCatalog} from '../src/domain/quickSearch';
import {cachedSearchFields} from '../src/domain/search';
import type {InventoryItem} from '../src/domain/inventory';

const features={sales:true,ecListing:true};
const row=(id:string,name:string,category:string):InventoryItem=>({id,name,category,sku:id,quantity:2,unit:'脚',location:'',condition:'',note:'',barcode:'',plannedSalePrice:null,thumbnailUrl:null,updatedAt:'2026-10-30T01:00:00Z'});
test('search initial value excludes only internal bracket memos; source name remains intact',()=>{
 const name='【在庫5】【補修】 arper  Catifa46';assert.equal(priceHistoryQuery(name),'arper Catifa46');assert.equal(name,'【在庫5】【補修】 arper  Catifa46');assert.equal(priceHistoryQuery('A'.repeat(500)).length,200);
});
test('cached lookup is limited to shipped stock, supports edited partial search and pagination',()=>{
 const catalog=new QuickSearchCatalog();const all=[row('a','arper Catifa46 ホワイト','発送完了,椅子'),row('b','arper Catifa46 ホワイト','販売中'),row('c','arper Catifa46','発送完了予定'),...Array.from({length:54},(_,i)=>row('done'+i,'arper Catifa46 ブラック','発送完了'))];
 catalog.replace(all,catalog.version());const fields=cachedSearchFields([],features);
 const first=catalog.search(priceHistorySearch('Catifa46'),fields)!;assert.equal(first.total,55);assert.equal(first.items.length,50);assert.equal(first.hasMore,true);assert.ok(first.items.every(isShippedInventory));
 const next=catalog.search(priceHistorySearch('Catifa46',first.nextOffset),fields)!;assert.equal(next.items.length,5);assert.equal(next.hasMore,false);assert.equal(new Set([...first.items,...next.items].map(i=>i.id)).size,55);
 assert.equal(catalog.search(priceHistorySearch('ホワイト'),fields)!.total,1);assert.equal(catalog.search(priceHistorySearch('存在しない'),fields)!.total,0);
});
test('sales detail projection respects sales and EC feature permissions',()=>{
 assert.ok(priceHistoryFields(features).some(f=>f.key==='salePrice'));
 assert.ok(priceHistoryFields({sales:true,ecListing:false}).every(f=>f.feature!=='ecListing'));
 assert.deepEqual(priceHistoryFields({sales:false,ecListing:false}),[]);
 const price=priceHistoryFields(features).find(f=>f.key==='salePrice')!;
 assert.equal(priceHistoryValue(price,'0'),'¥0');assert.equal(priceHistoryValue(price,''),'未入力');assert.equal(priceHistoryValue(price,'166000'),'¥166,000');
});
test('detail can no longer be displayed as a shipped result after category change or merge',()=>{
 assert.ok(!isShippedInventory(row('a','椅子','売り切れ')));
 assert.ok(!isShippedInventory({...row('a','椅子','発送完了'),mergedIntoInventoryId:'merged'}));
});

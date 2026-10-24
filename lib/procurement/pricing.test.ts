import test from 'node:test';
import assert from 'node:assert/strict';
import {procurementPurchasePrice as price} from './pricing';
import {purchaseUnitPrice,restageInventoryFields,type RestageLot} from './restage';
import {restageLedger,restageSupplement,ledgerFields} from './restageLedger';
test('リステージとトレファクの端数を正確に四捨五入する',()=>{
 assert.equal(price('RESTAGE',10000),11880);assert.equal(price('TREFAC',10000),12100);
 assert.equal(price('RESTAGE',1001),1189);assert.equal(price('TREFAC',1001),1211);
 assert.equal(price('TREFAC',50),61);assert.equal(price('RESTAGE',125),149);
 assert.equal(purchaseUnitPrice(1001,3,true),396);assert.equal(purchaseUnitPrice(125,2,true),74); // 74.25: round only after division
 assert.equal(price('TREFAC',50,2,true),30);
 for(const provider of ['RESTAGE','TREFAC'] as const)for(const n of [1,2,3,7,19])for(let amount=1;amount<10000;amount+=19){const d=1000n*BigInt(n);assert.equal(price(provider,amount,n,true),Number((BigInt(amount)*(provider==='RESTAGE'?1188n:1210n)+d/2n)/d));}
 for(const amount of [NaN,Infinity,0,-1,1.5,Number.MAX_SAFE_INTEGER])assert.throws(()=>price('RESTAGE',amount));
});
test('旧切り上げの登録を一度だけ補正し、手動変更した購入価格は保護する',()=>{
 const lot={goodsId:'123',date:'2026-10-23',name:'椅子3点一山',sourceQuantity:'1山',quantity:3,unit:'点',hammerPrice:1001,purchasePrice:396,isBundle:true,itemType:'椅子',imageUrl:'',lotNumber:'1'} as RestageLot;
 const ledger=restageLedger([lot]),defaults={locationId:'office',categoryId:'repair'};
 const row={...restageInventoryFields(lot),...ledgerFields(ledger),purchasePrice:397,adminMemo:restageInventoryFields(lot).adminMemo.replace('四捨五入','切り上げ'),customFields:{__restageImport:{date:lot.date,goodsId:lot.goodsId,multiplier:'1.188',rounding:'CEILING',ledger:{...ledger,rounding:undefined,purchaseTotal:1190},defaults}},dailyPurchaseTotal:1190};
 const changes=restageSupplement(row,lot,ledger,defaults);assert.equal(changes.purchasePrice,396);assert.equal(changes.dailyPurchaseTotal,1189);assert.match(String(changes.adminMemo),/四捨五入/);
 assert.deepEqual(restageSupplement({...row,...changes},lot,ledger,defaults),{});
 assert.throws(()=>restageSupplement({...row,purchasePrice:500},lot,ledger,defaults),/手動/);
 assert.throws(()=>restageSupplement({...row,customFields:{...row.customFields,__belloEditedFields:['purchasePrice']}},lot,ledger,defaults),/手動/);
});

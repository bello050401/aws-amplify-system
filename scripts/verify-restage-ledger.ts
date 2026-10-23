import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseRestageLots,restageInventoryFields} from '../lib/procurement/restage';
import {restageLedger,ledgerFields,restageSupplement,resolveRestageDefaults} from '../lib/procurement/restageLedger';
async function main(){
const lots=parseRestageLots(await readFile('scripts/fixtures/restage-wins.html','utf8'),'2026-10-23').lots;
const ledger=restageLedger(lots),defaults=resolveRestageDefaults([{id:'repair',name:'補修待ち'}],[{id:'office',name:'所沢事務所'}]);
assert.deepEqual(ledger,{version:2,date:'2026-10-23',lotCount:11,quantity:37,itemTypes:'テーブル 22点、椅子 7点、棚 2点、その他 6点',hammerTotal:211000,purchaseTotal:250668});
const lot=lots.find(l=>l.isBundle)!;
const original={...restageInventoryFields(lot),id:'one',images:['kept'],categoryIds:[],customFields:{material:'wood',__restageImport:{date:lot.date,goodsId:lot.goodsId}}};
const changes=restageSupplement(original,lot,ledger,defaults);
assert.equal(changes.purchaseQuantity,37);assert.equal(changes.dailyPurchaseTotal,250668);assert.equal(changes.usedGoodsItemType,ledger.itemTypes);
assert.deepEqual(changes.categoryIds,['repair']);assert.equal(changes.locationId,'office');
assert.equal(changes.quantity,undefined);assert.equal(changes.purchasePrice,undefined);assert.equal(changes.images,undefined);
assert.equal(original.quantity,3);assert.equal(original.purchasePrice,1188);
assert.deepEqual(restageSupplement({...original,...changes},lot,ledger,defaults),{});
assert.deepEqual(restageSupplement({...original,...changes,categoryId:null,categoryIds:[],locationId:null},lot,ledger,defaults),{},'later cleared defaults must stay cleared');
const explicitlyCleared=restageSupplement({...original,customFields:{...original.customFields,__belloEditedFields:['categoryIds','locationId']}},lot,ledger,defaults);
assert.equal(explicitlyCleared.categoryIds,undefined);assert.equal(explicitlyCleared.locationId,undefined);
assert.throws(()=>restageSupplement({...original,purchaseQuantity:42},lot,ledger,defaults),/変更されています/);
const preserved=restageSupplement({...original,categoryId:'other',categoryIds:['other'],locationId:'warehouse'},lot,ledger,defaults);
assert.equal(preserved.categoryId,undefined);assert.equal(preserved.locationId,undefined);
assert.throws(()=>restageLedger([...lots,lots[0]]));
assert.throws(()=>restageLedger([lots[0],{...lots[1],date:'2026-10-16'}]));
assert.throws(()=>resolveRestageDefaults([],[]));
assert.equal(ledgerFields(ledger).purchaseQuantity,37);
console.log(JSON.stringify({passed:true,ledger,defaultCategory:defaults.categoryId,defaultLocation:defaults.locationId,preservesIndividualStock:true,idempotent:true,guardsManualEdits:true},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});

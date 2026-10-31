import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateFee,DEFAULT_FEES,currentFeeConfig,validateFeeConfig} from '../lib/saleCandidates/model';
import {saleAmounts} from '../lib/inventory/salePricing';

test('Yahoo tax-exclusive fee is rounded once, tax is floored; shipping is excluded',()=>{
 assert.equal(DEFAULT_FEES.yahoo.rateBps,909);
 for(const [price,shipping,fee,net] of [[42800,13360,4280,51880],[34800,3260,3479,34581],[22800,3870,2280,24390],[9800,6930,980,15750]]){
  assert.equal(calculateFee('YAHOO',price,''),fee);
  assert.equal(price+shipping-fee,net);
 }
 for(const [price,fee] of [[10000,999],[166000,16597],[9999,999],[5,0],[0,0]])assert.equal(calculateFee('YAHOO',price,''),fee);
});
test('previous standard 10% config upgrades, custom and other-channel settings remain',()=>{
 const old=structuredClone(DEFAULT_FEES);old.yahoo={rateBps:1000,fixed:0,serviceBps:0,rounding:'ROUND'};old.base.rateBps=290;
 const next=currentFeeConfig(validateFeeConfig(old));assert.deepEqual(next.yahoo,DEFAULT_FEES.yahoo);assert.equal(next.base.rateBps,290);assert.equal(old.yahoo.rateBps,1000);
 const custom={...old,yahoo:{...old.yahoo,rateBps:800}};assert.equal(currentFeeConfig(custom).yahoo.rateBps,800);
});
test('commercial units and sets reconcile to one transaction fee, never charge shipping or physical pieces',()=>{
 for(const [mode,units,itemsPerUnit] of [['UNIT',3,1],['SET',3,2]] as const){
  const fee=calculateFee('YAHOO',11600*units,'')!;
  assert.equal(fee,3479);
  assert.deepEqual(saleAmounts({mode,units,itemsPerUnit,unitPrice:11600,unitCommission:fee/units}),{quantity:units*itemsPerUnit,salePrice:34800,saleCommission:3479});
 }
});

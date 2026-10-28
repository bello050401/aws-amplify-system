import {test} from "node:test";
import assert from "node:assert/strict";
import {calculateFee,DEFAULT_FEES,currentFeeConfig,validateFeeConfig} from "../lib/saleCandidates/model";
import {saleAmounts} from "../lib/inventory/salePricing";

test("Yahoo uses the requested gross 10% rule without another tax addition",()=>{
 assert.equal(DEFAULT_FEES.yahoo.rateBps,1000);
 for (const [price,fee] of [[10000,1000],[166000,16600],[9999,1000],[5,1],[0,0]]) assert.equal(calculateFee("YAHOO",price,""),fee);
});
test("legacy stored Yahoo 9.09% plus tax becomes 10%; other channel settings stay intact",()=>{
 const old=structuredClone(DEFAULT_FEES);old.yahoo={rateBps:909,fixed:0,serviceBps:0,rounding:"YAHOO_TAX"};old.base.rateBps=290;
 const next=currentFeeConfig(validateFeeConfig(old));
 assert.deepEqual(next.yahoo,DEFAULT_FEES.yahoo);assert.equal(next.base.rateBps,290);
 assert.equal(calculateFee("YAHOO",166000,"",old),16600);
 assert.equal(old.yahoo.rateBps,909);
});
test("fees multiply by sold commercial units, not physical pieces inside a set",()=>{
 const unitFee=calculateFee("YAHOO",10000,"");
 assert.deepEqual(saleAmounts({mode:"UNIT",units:2,itemsPerUnit:1,unitPrice:10000,unitCommission:unitFee}),{quantity:2,salePrice:20000,saleCommission:2000});
 assert.deepEqual(saleAmounts({mode:"SET",units:1,itemsPerUnit:2,unitPrice:10000,unitCommission:unitFee}),{quantity:2,salePrice:10000,saleCommission:1000});
 assert.deepEqual(saleAmounts({mode:"SET",units:2,itemsPerUnit:2,unitPrice:10000,unitCommission:unitFee}),{quantity:4,salePrice:20000,saleCommission:2000});
});

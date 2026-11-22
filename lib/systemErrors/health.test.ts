import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectAnalysisHealth, inspectLedgerHealth } from './health';
import { buildUsedGoodsLedger } from '../inventory/usedGoodsLedger';
import type { AnalysisResponse } from '../inventory/analysis/types';

function analysis(): AnalysisResponse {
  const totals={amount:100000,gross:110000,returns:10000,quantity:9,grossQuantity:10,returnedQuantity:1,kinds:2,lots:2,records:3,unknown:{amount:1,cost:1,quantity:0,category:1,kind:1,lot:1,channel:0,origin:0,date:0}};
  return {status:'ok',target:'inventory',period:null,metadata:{asOf:'2026-11-23T00:00:00Z'},inventoryValue:{asOf:'2026-11-23T00:00:00Z',total:100000,quantity:9},summary:{...totals,skus:1,unknownSkuRecords:1,dimensions:{category:[{...totals,key:'__unknown__',label:'未分類',color:'#999'}],holding:[{...totals,key:'unknown',label:'判定不明',color:'#999'}],skuCategory:[{...totals,amount:80000,quantity:8,skus:1,key:'chair',label:'椅子',color:'#999'}]}}} as AnalysisResponse;
}
test('valid returns, unknown costs and incomplete SKU money do not create repair incidents',()=>{
  const value=analysis(),before=structuredClone(value);
  assert.deepEqual(inspectAnalysisHealth(value),[]);
  assert.deepEqual(value,before);
  for(const status of ['missing','error','expired'] as const)assert.deepEqual(inspectAnalysisHealth({status}),[]);
});
test('wrong category totals and inconsistent current stock are detected independently',()=>{
  const value=analysis();value.summary.dimensions.category![0].amount++;
  assert.deepEqual(inspectAnalysisHealth(value),['category-total-mismatch']);
  const changed=analysis();changed.inventoryValue.total++;
  assert.deepEqual(inspectAnalysisHealth(changed),['aggregate-total-mismatch']);
  changed.inventoryValue.asOf='2026-11-22T00:00:00Z';
  assert.deepEqual(inspectAnalysisHealth(changed),[]);
});
test('a bad SKU count is detected without conflating SKU count and physical quantity',()=>{
  const value=analysis();value.summary.dimensions.skuCategory![0].skus=8;
  assert.deepEqual(inspectAnalysisHealth(value),['quantity-total-mismatch']);
  assert.equal(JSON.stringify(inspectAnalysisHealth(value)).includes('80000'),false);
});

test('gross and returned bucket quantities cannot cancel an inconsistent partition',()=>{
  const value=analysis();
  value.summary.dimensions.category![0].grossQuantity++;
  value.summary.dimensions.category![0].returnedQuantity++;
  assert.deepEqual(inspectAnalysisHealth(value),['quantity-total-mismatch']);
});
test('unknown ledger prices remain unknown, while known purchase-plus-shipping errors are found',()=>{
  const ledger=buildUsedGoodsLedger([{id:'synthetic-chair',name:'Chair',quantity:2,purchasePrice:10000,shippingCost:2000,transactionDate:'2026-11-23',counterpartyName:'Synthetic supplier',usedGoodsItemType:'椅子'}],2026,'2026-11-23T00:00:00Z');
  assert.deepEqual(inspectLedgerHealth(ledger),[]);
  const broken=structuredClone(ledger);broken.rows[0].total!++;
  assert.deepEqual(inspectLedgerHealth(broken),['aggregate-total-mismatch']);
  broken.rows[0].purchaseAmount=null;
  assert.deepEqual(inspectLedgerHealth(broken),[]);
});

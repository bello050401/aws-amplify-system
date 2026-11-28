import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryTrendValue, inventoryTrendLabel, inventoryTrendNote } from '../lib/inventory/salesInventoryTrend';
import { salesChart } from '../lib/inventory/salesChart';
import type { InventoryValue, InventoryValueView } from '../lib/inventory/inventoryValue';
import type { SalesTrendPoint } from '../lib/inventory/salesViewTypes';
const now = new Date('2026-11-28T06:23:40Z');
const snapshot = (asOf: string, month?: string): InventoryValueView => ({status:'ok',value:{total:11416710,asOf,month,source:'記録から復元'} as InventoryValue});
test('month-end keys, current freshness, future/error/missing remain distinct', async () => {
  const calls: (string|undefined)[]=[];
  const load = async (month?: string) => { calls.push(month); return month ? snapshot('2026-10-31T14:59:59.999Z', month) : snapshot('2026-11-28T06:23:39.388Z'); };
  assert.equal((await inventoryTrendValue('2026-10',load,now)).status,'ok');
  const current=await inventoryTrendValue('2026-11',load,now); assert.equal(current.current,true);
  assert.equal((await inventoryTrendValue('2026-12',load,now)).status,'missing');
  assert.deepEqual(calls,['2026-10',undefined]);
  for(const invalid of [snapshot('2026-10-31T14:59:59Z'),snapshot('2026-11-29T00:00:00Z'),snapshot('invalid')]) assert.equal((await inventoryTrendValue('2026-11',async()=>invalid,now)).status,'error');
  assert.equal((await inventoryTrendValue('2026-10',async()=>snapshot('2026-10-31T14:59:59Z','2026-09'),now)).status,'error');
  assert.equal((await inventoryTrendValue('2026-10',async()=>({status:'missing'}),now)).status,'missing');
  assert.equal((await inventoryTrendValue('2026-10',async()=>{throw Error('offline')},now)).status,'error');
});
test('inventory gaps never become zero; sales geometry is independent of inventory magnitudes',()=>{
  const point=(month:number,inventory:SalesTrendPoint['inventory']):SalesTrendPoint=>({year:2026,month,status:'ok',totalSales:100,totalGrossProfit:-10,inventory});
  const points=[point(8,{status:'ok',total:0,asOf:'2026-08-31T14:59:59Z'}),point(9,{status:'missing'}),point(10,{status:'ok',total:11399972,asOf:'2026-10-31T14:59:59Z',source:'記録から復元'}),point(11,{status:'ok',total:11416710,asOf:'2026-11-28T06:23:39Z',current:true})];
  const chart=salesChart(points);assert.equal((chart.inventoryPath.match(/M /g)||[]).length,2);assert.equal((chart.inventoryPath.match(/L /g)||[]).length,1);
  assert.equal(chart.salesPath,salesChart(points.map(p=>({...p,inventory:undefined}))).salesPath);
  assert.match(inventoryTrendLabel(points[2]),/2026\/10\/31 23:59 JST・記録から復元/);
  assert.match(inventoryTrendLabel(points[0]),/¥0/);assert.match(inventoryTrendLabel(points[1]),/データなし/);
  assert.match(inventoryTrendNote(points),/11\/28時点/);assert.match(inventoryTrendNote(points),/記録あり：2026\/8・2026\/10・2026\/11/);
});

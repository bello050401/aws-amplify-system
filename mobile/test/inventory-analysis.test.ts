import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analysisRequest,displayRows,formatMetric,initialAnalysisState,metricFor,stateFromQuery,summaryRequest,unknownAmount,writeQuery} from '../../lib/inventory/analysisUi/model';
import {createFixtures,previewToday} from '../../lib/inventory/analysisUi/fixtures';

test('inventory metrics use the selected denominators and fixed generation',async()=>{
  const {ports} = createFixtures();
  const state = initialAnalysisState(previewToday);
  state.tab = 'inventory';
  const result = await ports.load(analysisRequest(state,previewToday)!);
  assert.equal(result.status,'ok');
  if (result.status!=='ok') return;
  assert.equal(result.inventoryValue.total,100_000);
  assert.equal(result.inventoryValue.quantity,9);
  const group = result.summary.dimensions.holdingCount!;
  for (const [metric,value,pct] of [['amount',80000,80],['quantity',8,88.9],['kinds',1,50]] as const) {
    const row = displayRows(group,metric,false,false,false,'inventory','holdingCount').rows.find(row=>row.key==='8')!;
    assert.equal(row.value,value);
    assert.equal(Number(row.percent.toFixed(1)),pct);
  }
  const request = {target:'inventory',generation:result.metadata.generation,dimension:'holdingCount',key:'8'} as const;
  const drill = await ports.drill(request);
  assert.equal(drill.status,'ok');
  if(drill.status!=='ok') return;
  assert.equal(drill.items[0].type,'group');
  const members = await ports.drill({...request,groupKindId:'kind-bench'});
  assert.ok(members.status==='ok' && members.items.length===2);
  assert.equal((await ports.drill({...request,generation:'expired'})).status,'expired');
});

test('sale date, acquisition metric and generation detail survive state restoration',()=>{
  const state = stateFromQuery(new URLSearchParams('period=rolling'),previewToday);
  const request = analysisRequest(state,previewToday);
  assert.deepEqual(request,{target:'sales',rollingDays:30});
  state.slice = {dimension:'lot',key:'multiple',label:'複数仕入れ',request:{...request!,generation:'fixed'}};
  const query = writeQuery(new URLSearchParams(),state);
  const reopened = stateFromQuery(query,'2026-12-04');
  assert.deepEqual(reopened.slice,state.slice);
  reopened.tab = 'breakdown';
  reopened.breakdown = 'acquisitions';
  reopened.acquisitionUnit = 'lots';
  assert.equal(metricFor(reopened),'lots');
  assert.equal(formatMetric(3,metricFor(reopened)),'3ロット');
});

test('pinned sales reads retain the selected generation and price coverage',async()=>{
  const request = {target:'sales'} as const;
  const fixture = createFixtures('generation-race');
  const first = await createFixtures().ports.load(request);
  assert.ok(first.status==='ok');
  const pinned = summaryRequest(request,first.metadata.generation)!;
  const [stable,latest] = await Promise.all([fixture.ports.load(pinned),fixture.ports.load(request)]);
  assert.ok(stable.status==='ok' && latest.status==='ok');
  assert.equal(stable.metadata.generation,first.metadata.generation);
  assert.notEqual(latest.metadata.generation,stable.metadata.generation);
  assert.equal(summaryRequest(request,null),null);
  for (const [mode,amount,unknown] of [['known-sale',100000,0],['zero-sale',0,0],['unknown-sale',0,1]] as const) {
    const data = await createFixtures(mode).ports.load(request);
    assert.ok(data.status==='ok');
    assert.equal(data.summary.amount,amount);
    assert.equal(data.summary.unknown.cost,1);
    assert.equal(unknownAmount(data.summary,'sales'),unknown);
    assert.equal(displayRows(data.summary.dimensions.category!,'amount',false,false,true,'sales').rows[0].unknownValue,!!unknown);
  }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AnalysisResultView} from '../app/inventory/(protected)/sales/analysis/SalesAnalysis';
import {AnalysisDonut} from '../app/inventory/(protected)/sales/analysis/AnalysisDonut';
import {createFixtures,previewToday} from '../lib/inventory/analysisUi/fixtures';
import {comparisonBuckets} from '../lib/inventory/analysisUi/comparison';
import {inventoryComparisonRequest,stateFromQuery,writeQuery,type Slice,type DisplayRow,type Bucket} from '../lib/inventory/analysisUi/model';
(globalThis as unknown as {React:typeof React}).React=React;

function descendants(element:React.ReactNode):React.ReactElement[] {
  if (!React.isValidElement(element)) return [];
  return [element,...React.Children.toArray((element.props as {children?:React.ReactNode}).children).flatMap(descendants)];
}

test('comparison uses captured date, SKU counts, consistent colors and exact historical drill/return',async()=>{
  const {ports}=createFixtures('comparison');
  const current=await ports.load({target:'inventory'});
  assert.equal(current.status,'ok');if(current.status!=='ok') return;
  const request=inventoryComparisonRequest(current.metadata.asOf,2);
  const historical=await ports.load(request);
  assert.equal(historical.status,'ok');if(historical.status!=='ok') return;
  assert.equal(historical.summary.skus,4);
  assert.notEqual(historical.summary.skus,historical.summary.quantity);
  const chosen:Slice[]=[];
  const element=AnalysisResultView({data:historical,retry:()=>{},request,metric:'skus',detailed:false,select:slice=>chosen.push(slice),historical:true,comparison:true});
  const html=renderToStaticMarkup(element);
  assert.match(html,/この時点のSKU/);assert.match(html,/2026\/10\/31/);assert.match(html,/11:17/);assert.match(html,/4 SKU/);
  const charts=descendants(element).filter(item=>item.type===AnalysisDonut);
  assert.equal(charts.length,2);
  for(const chart of charts){
    const props=chart.props as React.ComponentProps<typeof AnalysisDonut>;
    for(const bucket of props.buckets){
      const same:Bucket|undefined=current.summary.dimensions[props.dimension]?.find(row=>row.key===bucket.key);
      if(same) assert.equal(bucket.color,same.color);
    }
    const row=props.buckets.find(item=>item.skus && item.skus>0)!;
    props.onSelect({key:row.key,label:row.label} as DisplayRow);
  }
  for(const slice of chosen){
    assert.equal(slice.request.daily,'2026-10-31');
    assert.equal(slice.request.generation,'synthetic-inventory-2026-10-31');
    const state=stateFromQuery(new URLSearchParams('view=breakdown&compareWeeks=2'),previewToday);
    state.slice=slice;
    const restored=stateFromQuery(writeQuery(new URLSearchParams(),state),'2026-12-01');
    assert.deepEqual(restored.slice,slice);assert.equal(restored.inventoryCompareWeeks,2);
    assert.equal((await ports.drill({...restored.slice!.request,dimension:slice.dimension,key:slice.key})).status,'ok');
    restored.slice=null;
    assert.equal(stateFromQuery(writeQuery(new URLSearchParams(),restored),previewToday).inventoryCompareWeeks,2);
  }
});

test('missing, failure and absent legacy SKU render distinct states without zero charts',async()=>{
  const {ports}=createFixtures('comparison');
  for(const [weeks,label] of [[3,'この日の在庫データはありません。'],[4,'集計を取得できませんでした。']] as const){
    const request=inventoryComparisonRequest('2026-11-14T03:00:00Z',weeks);
    const data=await ports.load(request);
    const html=renderToStaticMarkup(AnalysisResultView({data,retry:()=>{},request,metric:'skus',detailed:false,select:()=>{},historical:true}));
    assert.ok(html.includes(label));assert.ok(!html.includes('<svg'));assert.ok(!html.includes('0 SKU'));
    assert.equal(html.includes('集計を再試行'),weeks===4);
  }
  const request={target:'inventory',daily:'2026-10-31'} as const;
  const data=await createFixtures('comparison-legacy').ports.load(request);
  const html=renderToStaticMarkup(AnalysisResultView({data,retry:()=>{},request,metric:'skus',detailed:false,select:()=>{},historical:true}));
  assert.ok(html.includes('この時点のSKU内訳の記録はありません。'));assert.ok(!html.includes('<svg'));
});

test('inventory amount comparison retains cost denominator',async()=>{
  const request={target:'inventory',daily:'2026-10-31'} as const;
  const data=await createFixtures('comparison').ports.load(request);
  const html=renderToStaticMarkup(AnalysisResultView({data,retry:()=>{},request,metric:'amount',detailed:false,select:()=>{},historical:true,comparison:true}));
  assert.ok(html.includes('在庫金額'));assert.ok(html.includes('原価'));assert.ok(!html.includes('4 SKU'));
});

test('comparison legends include one-sided categories and holding counts without changing either total',async()=>{
  const {ports}=createFixtures('comparison');
  const current=await ports.load({target:'inventory'});
  const historical=await ports.load({target:'inventory',daily:'2026-10-31'});
  assert.equal(current.status,'ok');assert.equal(historical.status,'ok');
  if(current.status!=='ok'||historical.status!=='ok')return;
  const original=JSON.stringify([current,historical]);
  for(const dimension of ['skuCategory','skuHoldingCount'] as const){
    const now:Bucket[]=current.summary.dimensions[dimension]??[],past:Bucket[]=historical.summary.dimensions[dimension]??[];
    const left=comparisonBuckets(now,past,dimension,now),right=comparisonBuckets(past,now,dimension,now);
    assert.deepEqual(left.map(b=>b.key),right.map(b=>b.key));
    assert.equal(left.reduce((sum,b)=>sum+(b.skus??0),0),current.summary.skus);
    assert.equal(right.reduce((sum,b)=>sum+(b.skus??0),0),historical.summary.skus);
    const onlyNow:Bucket[]=now.filter(b=>!past.some(p=>p.key===b.key));
    assert.ok(onlyNow.length>0);
    for(const row of onlyNow){const added=right.find(b=>b.key===row.key)!;assert.equal(added.skus,0);assert.equal(added.color,row.color);}
  }
  const currentBands=current.summary.dimensions.skuHoldingCount??[];
  const pastOnly=[{...currentBands[0],key:'9',label:'9点保有',skus:1}];
  const union=comparisonBuckets(currentBands,pastOnly,'skuHoldingCount',currentBands);
  assert.deepEqual(union.map(b=>b.key),['1','2','3','5','8','9']);assert.equal(union.at(-1)!.skus,0);
  const html=renderToStaticMarkup(AnalysisResultView({data:historical,retry:()=>{},request:{target:'inventory',daily:'2026-10-31'},metric:'skus',detailed:false,select:()=>{},historical:true,comparison:true,counterpart:current}));
  assert.match(html,/収納家具/);assert.match(html,/3点保有/);assert.match(html,/8点保有/);assert.match(html,/0 SKU/);
  assert.equal(JSON.stringify([current,historical]),original);
});

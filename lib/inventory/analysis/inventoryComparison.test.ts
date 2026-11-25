import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BatchGetCommand, GetCommand, type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {buildAnalysis} from './aggregate';
import {dailyKey, makeAnalysisManifest, shardKey} from './publicationFormat';
import {createAnalysisReader, loadAnalysis} from './reader';
import {analysisReturnHref, comparisonDay, initialAnalysisState, inventoryComparisonRequest, matchingAnalysisResult, stateFromQuery, writeQuery} from '../analysisUi/model';
import type {AnalysisBuild} from './types';

const currentAsOf = '2026-11-25T15:00:00.000Z'; // November 26 in Japan.
const now = Date.parse(currentAsOf);
const workflow = [{id:'active',name:'販売中'}];
const inventory = (quantities = [2,3,5]) => [
  {id:'two-a',sku:'TWO',name:'ダイニングチェア',quantity:1,purchasePrice:100,categoryId:'active'},
  {id:'two-b',sku:'TWO',name:'ダイニングチェア',quantity:quantities[0]-1,purchasePrice:200,categoryId:'active'},
  {id:'three',sku:'THREE',name:'テーブル',quantity:quantities[1],purchasePrice:300,categoryId:'active'},
  {id:'five',sku:'FIVE',name:'ソファ',quantity:quantities[2],purchasePrice:400,categoryId:'active'},
];
function capture(asOf:string,quantities?:number[]) {
  return buildAnalysis(inventory(quantities),workflow,[],asOf,asOf);
}
function historicalDb(builds:AnalysisBuild[]) {
  const records = new Map<string,Record<string,unknown>>();
  const reads:string[] = [];
  for (const build of builds) {
    const {dailyManifest,shards} = makeAnalysisManifest(build);
    records.set(dailyKey(build.metadata.coverageEnd),{
      generation:build.metadata.generation,analysisManifestJson:JSON.stringify(dailyManifest),
      analysisRetainUntil:Math.floor(now/1000)+86400,
    });
    for (const shard of shards) records.set(shard.id,{id:shard.id,analysisShardJson:shard.json});
  }
  const db = {send:async (command:GetCommand|BatchGetCommand)=>{
    if (command instanceof GetCommand) {
      const id = String(command.input.Key!.id);
      reads.push(id);
      return {Item:records.get(id)};
    }
    const ids = command.input.RequestItems!.snapshot.Keys!.map(key=>String(key.id));
    reads.push(...ids);
    return {Responses:{snapshot:ids.flatMap(id=>records.get(id) ?? [])}};
  }} as Pick<DynamoDBDocumentClient,'send'>;
  return {db,records,reads,reader:createAnalysisReader({authorize:async()=>true,load:request=>loadAnalysis(db,'snapshot',request,now)})};
}

test('comparison dates use the captured JST day across month, year and leap boundaries',()=>{
  assert.deepEqual(inventoryComparisonRequest(currentAsOf,2),{target:'inventory',daily:'2026-11-12'});
  assert.deepEqual(inventoryComparisonRequest('2026-11-25T14:59:59.999Z',2),{target:'inventory',daily:'2026-11-11'});
  assert.equal(comparisonDay('2027-01-04',3),'2026-12-14');
  assert.equal(comparisonDay('2024-03-14',2),'2024-02-29');
  assert.equal(comparisonDay('2026-03-01',4),'2026-02-01');
  assert.throws(()=>comparisonDay('2026-02-30',2),/INVALID_DATE/);
  assert.throws(()=>comparisonDay('2026-11-25',1 as 2),/INVALID_COMPARISON_WEEKS/);
});

test('comparison selection and historical SKU drilldown survive return links',()=>{
  const state = initialAnalysisState('2026-11-26');
  assert.equal(state.inventoryCompareWeeks,0);
  state.tab = 'breakdown';
  state.inventoryCompareWeeks = 3;
  state.slice = {dimension:'skuHoldingCount',key:'3',label:'3点保有',request:{target:'inventory',daily:'2026-11-05',generation:'2026-11-05T03:00:00.000Z'}};
  const query = writeQuery(new URLSearchParams(),state);
  const restored = stateFromQuery(query,'2026-12-01');
  assert.equal(restored.inventoryCompareWeeks,3);
  assert.deepEqual(restored.slice,state.slice);
  const href = analysisReturnHref(query.toString(),'2026-12-01')!;
  assert.deepEqual(stateFromQuery(new URL(href,'https://fixture.invalid').searchParams,'2026-12-01').slice,state.slice);
  assert.equal(stateFromQuery(new URLSearchParams('compareWeeks=1'),'2026-11-26').inventoryCompareWeeks,0);
  query.set('detailDaily','2026-02-30');
  assert.equal(stateFromQuery(query,'2026-11-26').slice,null);
});

test('2, 3 and 4 week reads use genuine daily captures and retain exact SKU bands and cost',async()=>{
  const builds = ['2026-11-12','2026-11-05','2026-10-29'].map(day=>capture(day+'T03:00:00.000Z'));
  const fixture = historicalDb(builds);
  let categoryColors:unknown;
  for (const weeks of [2,3,4] as const) {
    const request = inventoryComparisonRequest(currentAsOf,weeks);
    const result = await fixture.reader.summary(request);
    assert.equal(result.status,'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.metadata.coverageEnd,request.daily);
    assert.equal(result.metadata.asOf,request.daily+'T03:00:00.000Z');
    assert.equal(result.summary.skus,3);
    assert.equal(result.summary.quantity,10);
    assert.equal(result.summary.amount,3200); // Cost = 100 + 200 + 3x300 + 5x400.
    assert.equal(result.inventoryValue.total,3200);
    assert.deepEqual(result.summary.dimensions.skuHoldingCount?.map(bucket=>[bucket.key,bucket.skus]),[['2',1],['3',1],['5',1]]);
    for (const dimension of ['skuCategory','skuHoldingCount'] as const) {
      assert.equal(result.summary.dimensions[dimension]!.reduce((total,bucket)=>total+(bucket.skus??0),0),3);
    }
    const colors = result.summary.dimensions.skuCategory!.map(bucket=>[bucket.key,bucket.color]);
    if (categoryColors) assert.deepEqual(colors,categoryColors);
    categoryColors = colors;
  }
  assert.equal(fixture.reads.length,6); // One daily manifest and one inventory shard per selection.
  assert(fixture.reads.every(id=>id.startsWith('analysis:d:') || id.includes(':inventory:')));
});

test('historical detail and cursors remain bound to daily, generation and SKU band',async()=>{
  const first = capture('2026-11-12T03:00:00.000Z',[2,2,5]);
  const fixture = historicalDb([first]);
  const request = {target:'inventory',daily:'2026-11-12',generation:first.metadata.generation,dimension:'skuHoldingCount',key:'2',limit:1} as const;
  const page = await fixture.reader.detail(request);
  assert.equal(page.status,'ok');
  if (page.status !== 'ok') return;
  assert.equal(page.items.length,1);
  assert.ok(page.nextCursor);
  const next = await fixture.reader.detail({...request,cursor:page.nextCursor});
  assert.equal(next.status,'ok');
  if (next.status === 'ok') assert.equal(next.items.length,1);
  assert.equal((await fixture.reader.detail({...request,key:'5',cursor:page.nextCursor})).status,'error');
  assert.equal((await fixture.reader.detail({...request,daily:undefined,cursor:page.nextCursor})).status,'expired');
  const group = [...page.items,...(next.status==='ok'?next.items:[])].find(item=>item.type==='sku-group');
  assert.ok(group?.type==='sku-group');
  const members = await fixture.reader.detail({...request,groupSku:group.group.groupKey,limit:20});
  assert.equal(members.status,'ok');
  if (members.status === 'ok') assert.equal(members.items.length,2);
});

test('missing, expired and damaged historical captures never read or substitute current inventory',async()=>{
  const build = capture('2026-11-12T03:00:00.000Z');
  const fixture = historicalDb([build]);
  const request = inventoryComparisonRequest(currentAsOf,2);
  assert.equal((await fixture.reader.summary(inventoryComparisonRequest(currentAsOf,3))).status,'missing');
  const id = shardKey(build.metadata.generation,'inventory',0);
  fixture.records.delete(id);
  assert.equal((await fixture.reader.summary(request)).status,'error');
  assert.equal((await fixture.reader.detail({...request,generation:build.metadata.generation,dimension:'skuHoldingCount',key:'2'})).status,'error');
  fixture.records.get(dailyKey(request.daily!))!.analysisRetainUntil = Math.floor(now/1000);
  assert.equal((await fixture.reader.summary(request)).status,'missing');
  assert.equal((await fixture.reader.detail({...request,generation:build.metadata.generation,dimension:'skuHoldingCount',key:'2'})).status,'expired');
  assert(!fixture.reads.includes('current'));
});

test('response matching preserves unavailable states and rejects a substituted current snapshot',async()=>{
  const build = capture('2026-11-12T03:00:00.000Z');
  const result = await historicalDb([build]).reader.summary({target:'inventory',daily:'2026-11-12'});
  assert.equal(result.status,'ok');
  assert.deepEqual(matchingAnalysisResult({target:'inventory',daily:'2026-11-05'},result),{status:'error'});
  assert.deepEqual(matchingAnalysisResult({target:'sales'},result),{status:'error'});
  assert.deepEqual(matchingAnalysisResult({target:'inventory',generation:currentAsOf},result),{status:'expired'});
  for (const status of ['missing','expired','error'] as const) assert.deepEqual(matchingAnalysisResult({target:'inventory'},{status}),{status});
});

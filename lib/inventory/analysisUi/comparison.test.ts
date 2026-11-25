import assert from 'node:assert/strict';
import {test} from 'node:test';
import {comparisonRows,signedChange,formatPercentagePointDelta,inventoryHistorySummary} from './comparison';
import {stateFromQuery,writeQuery,type Bucket} from './model';
import {createFixtures} from './fixtures';
const bucket=(key:string,value:number,color='#123456',unknown=false):Bucket=>({key,label:key,color,amount:value,gross:value,returns:0,quantity:value,grossQuantity:value,returnedQuantity:0,kinds:1,lots:1,records:1,skus:value,unknown:{amount:unknown?1:0,cost:unknown?1:0,quantity:0,category:0,kind:0,lot:0,channel:0,origin:0,date:0}});
test('captures share colors and exact count order, including appeared/disappeared groups',()=>{
 const rows=comparisonRows([bucket('2',5,'#111111'),bucket('1',2)],[bucket('2',2,'#ffffff'),bucket('3',4)],'skuHoldingCount','skus');
 assert.deepEqual(rows.map(row=>row.key),['1','2','3']);
 assert.equal(rows[1].prior.color,rows[1].current.color);assert.equal(rows[1].color,'#111111');
 assert.equal(rows[0].change,2);assert.equal(rows[1].change,3);assert.equal(rows[2].change,-4);
 assert.equal(rows[2].current.value,0);
});
test('unknown costs suppress delta; zero composition has no percentage point claim',()=>{
 const rows=comparisonRows([bucket('a',0,'#111111',true)],[bucket('a',5)],'category','amount');
 assert.equal(rows[0].change,null);assert.equal(rows[0].points,null);
 const zero=comparisonRows([bucket('a',0)],[bucket('a',0)],'category','amount')[0];assert.equal(zero.change,0);assert.equal(zero.points,null);
 assert.equal(signedChange(-3,value=>value+' SKU'),'−3 SKU');assert.equal(signedChange(null,String),'—');
});

test('exact comparison day and capture detail survive URL restoration',()=>{
 const state=stateFromQuery(new URLSearchParams('view=breakdown&compareDay=2026-10-31'),'2026-11-14');
 assert.equal(state.inventoryCompareDay,'2026-10-31');
 assert.equal(stateFromQuery(writeQuery(new URLSearchParams(),state),'2026-11-14').inventoryCompareDay,'2026-10-31');
 assert.equal(stateFromQuery(new URLSearchParams('compareDay=2026-02-30'),'2026-11-14').inventoryCompareDay,'');
 assert.equal(stateFromQuery(new URLSearchParams('compareDay=2026-12-01'),'2026-11-14').inventoryCompareDay,'');
});

test('reconstructed fixture retains original capture time and visible reference provenance',async()=>{
 const {ports}=createFixtures('comparison-reconstructed');
 const capture=await ports.load({target:'inventory',daily:'2026-10-31'});
 assert.equal(capture.status,'ok');if(capture.status!=='ok')return;
 assert.equal(capture.metadata.asOf,'2026-10-31T02:17:00.000Z');
 assert.equal(capture.metadata.accuracy,'reference-reconstructed');
 assert.equal(capture.metadata.inventoryHistory?.skuBasis,'historical-baseline-and-immutable-link');
 assert.equal(capture.metadata.inventoryHistory?.sourceCapturedAt,capture.metadata.asOf);
 const current=await ports.load({target:'inventory'});assert.equal(current.status,'ok');
 if(current.status==='ok')assert.deepEqual(current.metadata.inventoryHistoryAvailableDays,['2026-10-31']);
});

test('reconstruction summary names proven identity sources and quantity exclusions',()=>{
 const text=inventoryHistorySummary({basis:'archived-source',sourceSystem:'ZAICO',sourceCapturedAt:'2026-10-31T00:00:00Z',reconstructedAt:'2026-11-14T00:00:00Z',sourceKeyDigest:'synthetic',sourceRecordCount:5,unmatchedSourceRecords:0,skuBasis:'historical-baseline-and-immutable-link',historicalIdentityRecords:3,currentIdentityRecords:2,unknownQuantityRecords:1,limitations:[]});
 assert.match(text,/当時の記録 3件/);assert.match(text,/変更のない連携情報 2件/);assert.match(text,/数量未確認のため対象外 1件/);assert.ok(!text.includes('参考'));
});

test('percentage point signs follow the rounded visible difference',()=>{
 for(const value of [0, -0, 0.049, -0.049]) assert.equal(formatPercentagePointDelta(value),'0.0pt');
 assert.equal(formatPercentagePointDelta(0.1),'+0.1pt');
 assert.equal(formatPercentagePointDelta(-0.1),'−0.1pt');
 assert.equal(formatPercentagePointDelta(0.051),'+0.1pt');
 assert.equal(formatPercentagePointDelta(-0.051),'−0.1pt');
 assert.equal(formatPercentagePointDelta(null),'—');
});

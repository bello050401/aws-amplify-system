import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GetCommand,QueryCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import type {ArchivedStock,InventoryWindow} from '../inventoryValueHistory';
import {reconstructArchivedInventory,type ArchiveIdentity} from './archiveHistory';
import {historicalPublicationItems,publishHistoricalInventory} from './historyPublication';
import {makeAnalysisManifest,parseAnalysisManifest} from './publicationFormat';
import {inventoryHistoryDays,loadAnalysis} from './reader';
import {queryAnalysis} from './query';

const asOf='2026-11-10T18:33:17.1Z',now='2026-11-25T22:00:00.000Z',day='2026-11-11';
const stock=(id=1,quantity:ArchivedStock['quantity']='3',changes:Partial<ArchivedStock>={}):ArchivedStock=>({id,title:'ダイニングチェア',quantity,category:'販売中,川越移動予定',optional_attributes:{'⚫︎購入価格':'1,000'},deleted:false,updated_at:'2026-11-10T16:00:00Z',...changes});
const identity=(id='local-1',sku='B0001',changes:Partial<ArchiveIdentity>={}):ArchiveIdentity=>({id,sku,createdAt:'2026-10-20T00:00:00.000Z',basis:'historical-baseline',linkable:true,...changes});
const links=new Map([['1',identity()],['2',identity('local-2','B0002')]]);
const window=(remote=[stock()]):InventoryWindow=>({key:'archive/full-20261111',full:true,end:asOf,remote});
const build=(remote?:ArchivedStock[])=>reconstructArchivedInventory(window(remote),day,links,now);

test('exact historical JST capture anchor, normalized precision and immutable source',()=>{
  const source=window(),before=structuredClone(source),a=reconstructArchivedInventory(source,day,links,now);
  assert.equal(a.metadata.asOf,'2026-11-10T18:33:17.100Z');assert.equal(a.metadata.coverageEnd,day);
  assert.equal(a.metadata.inventoryHistory?.sourceCapturedAt,a.metadata.asOf);assert.equal(a.metadata.inventoryHistory?.reconstructedAt,now);
  assert.deepEqual(source,before);assert.throws(()=>reconstructArchivedInventory(source,'2026-11-10',links,now),/ANCHOR/);
  assert.throws(()=>reconstructArchivedInventory({...source,full:false},day,links,now),/ANCHOR/);
});
test('recorded split quantities and sold reversals are separate daily observations without doubling',()=>{
  const earlier=build(),split=build([stock(1,'2'),stock(2,'1',{category:'売り切れ'})]);
  assert.equal(earlier.inventoryValue.quantity,3);assert.equal(split.inventoryValue.quantity,2);assert.equal(split.inventoryValue.total,2000);
  const reversed=build([stock(1,'3'),stock(2,'0',{deleted:true})]);assert.equal(reversed.inventoryValue.quantity,3);assert.equal(reversed.inventory.length,1);
  assert.equal(earlier.inventoryValue.quantity,3); // Later observations cannot mutate prior snapshots.
});
test('immutable identity mapping never copies current business values or mislabels post-capture rows',()=>{
  const unsafe=new Map([['1',{...identity(),createdAt:'2026-11-12T00:00:00Z',quantity:999,purchasePrice:999999}]]);
  const a=reconstructArchivedInventory(window(),day,unsafe,now);
  assert.equal(a.inventoryValue.quantity,3);assert.equal(a.inventoryValue.total,3000);assert.equal(a.inventory[0].sku,null);assert.equal(a.inventory[0].inventoryId,null);
  assert.equal(a.metadata.inventoryHistory?.unmatchedSourceRecords,1);
});
test('historical SKU survives deleted current item without a broken product link',()=>{
  const a=reconstructArchivedInventory(window(),day,new Map([['1',identity('deleted','B-OLD',{linkable:false})]]),now);
  assert.equal(a.inventory[0].inventoryId,null);assert.equal(a.inventory[0].sku,'B-OLD');
  const result=queryAnalysis(a,{target:'inventory',daily:day});assert.equal(result.status,'ok');if(result.status==='ok')assert.equal(result.summary.skus,1);
});
test('unknown quantity stays explicitly excluded and cannot fabricate historical zero or original lot quantity',()=>{
  const a=build([stock(1,null),stock(2,'２')]);assert.equal(a.inventoryValue.quantity,2);assert.equal(a.inventoryValue.total,2000);
  assert.equal(a.metadata.inventoryHistory?.unknownQuantityRecords,1);assert.equal(a.inventory.length,1);
  assert.match(a.metadata.inventoryHistory!.limitations.join(' '),/数量を確認できない在庫1件/);
  const closed=build([stock(1,null,{category:'売り切れ'}),stock(2,'1')]);assert.equal(closed.metadata.inventoryHistory?.unknownQuantityRecords,0);
});
test('duplicate sources, duplicate identity links, future-row data and invalid quantity fail closed',()=>{
  assert.throws(()=>build([stock(),stock()]),/DUPLICATE_SOURCE/);
  assert.throws(()=>reconstructArchivedInventory(window([stock(),stock(2)]),day,new Map([['1',identity()],['2',identity()]]),now),/DUPLICATE_LINK/);
  assert.throws(()=>build([stock(1,'2',{updated_at:'2026-11-11T01:00:00Z'})]),/FUTURE_ROW/);
  assert.throws(()=>build([stock(1,'bad')]),/QUANTITY/);
});
test('historical manifest provenance is validated and cannot masquerade as a different capture',()=>{
  const {dailyManifest}=makeAnalysisManifest(build());const json=JSON.stringify(dailyManifest);
  assert.equal(parseAnalysisManifest(json,dailyManifest.header.metadata.generation).header.metadata.accuracy,'reference-reconstructed');
  dailyManifest.header.metadata.inventoryHistory!.sourceCapturedAt=now;
  assert.throws(()=>parseAnalysisManifest(JSON.stringify(dailyManifest),dailyManifest.header.metadata.generation),/PROVENANCE/);
});
test('all historical writes are atomic missing-only creates and never touch current/captured/source',async()=>{
  const a=build(),items=historicalPublicationItems(a,'test'),calls:TransactWriteCommand[]=[];
  assert.ok(items.every(item=>item.id!=='current'));assert.ok(items.some(item=>item.id==='analysis:d:'+day));
  const db={send:async(command:TransactWriteCommand)=>{calls.push(command);return {};}};
  assert.equal(await publishHistoricalInventory(db as never,'snapshots',a,'test'),true);assert.equal(calls.length,1);
  assert.ok(calls[0].input.TransactItems!.every(item=>item.Put?.ConditionExpression==='attribute_not_exists(id)'&&item.Put.TableName==='snapshots'));
  const conflict={send:async()=>{throw {name:'TransactionCanceledException',CancellationReasons:[{Code:'ConditionalCheckFailed'}]};}};
  assert.equal(await publishHistoricalInventory(conflict as never,'snapshots',a,'test'),false);
  assert.equal(a.metadata.asOf,'2026-11-10T18:33:17.100Z');
});
test('availability lists only real daily pointer dates, sorts and deduplicates pagination',async()=>{
  let calls=0;const db={send:async(command:QueryCommand)=>{assert.equal(command.input.IndexName,'AnalysisRetention');calls++;return calls===1?{Items:[{id:'analysis:d:2026-11-11'},{id:'invalid'}],LastEvaluatedKey:{id:'next'}}:{Items:[{id:'analysis:d:2026-10-28'},{id:'analysis:d:2026-11-11'},{id:'analysis:d:2026-02-30'}]};}};
  assert.deepEqual(await inventoryHistoryDays(db as never,'snapshots',Date.parse(now)),['2026-10-28','2026-11-11']);assert.equal(calls,2);
});
test('inventory reconstruction is never exposed as reconstructed sales zero',async()=>{
  const a=build(),{dailyManifest}=makeAnalysisManifest(a),db={send:async(command:GetCommand)=>({Item:{generation:a.metadata.generation,analysisManifestJson:JSON.stringify(dailyManifest),analysisRetainUntil:Date.parse(now)/1000+86400}})};
  assert.deepEqual(await loadAnalysis(db as never,'snapshots',{target:'sales',generation:a.metadata.generation},Date.parse(a.metadata.asOf)+1000),{status:'missing'});
});

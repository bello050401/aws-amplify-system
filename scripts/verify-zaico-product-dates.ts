import assert from 'node:assert/strict';
import {harness} from './verify-zaico-transition-runner';
import {sourceDatePatch,sourceDatesUpdate} from '../lib/zaico/transition/sourceDates';
import {productUpdatedAt,compareInventoryDateDesc} from '../lib/inventory/productDates';
import {inventoryComparator} from '../lib/inventory/searchSort';
import {buildScanProjection} from '../lib/inventory/searchScanProjection';
import {toListRow} from '../lib/inventory/queries';
import {evaluateQuery,buildSearchFieldDefs} from '../lib/inventory/advancedSearch';
import {cachedInventorySearch} from '../mobile/src/domain/search';
import type {InventoryItem} from '../mobile/src/domain/inventory';

async function main(){
 const h=harness();h.seed();
 Object.assign(h.remotes.get('1')!,{created_at:'2022-05-07T00:00:00+09:00',updated_at:'2026-04-22T14:49:07+09:00',update_date:'2024-12-28T17:27:29+09:00'});
 await h.run();const imported=h.rows.get('one')!;
 assert.equal(imported.createdAt,'2022-05-06T15:00:00.000Z');
 assert.equal(imported.listUpdatedAt,'2024-12-28T08:27:29.000Z');
 assert.notEqual(imported.updatedAt,imported.listUpdatedAt);
 const version=imported.updatedAt;h.calls.length=0;await h.tick();
 assert.equal(h.rows.get('one')!.updatedAt,version);assert.deepEqual(h.calls.map(c=>c.method),['LIST']);
 // Internal ZAICO writes do not reorder the user's inventory list.
 h.remotes.get('1')!.updated_at='2026-10-21T18:00:00+09:00';await h.tick();
 assert.equal(h.rows.get('one')!.listUpdatedAt,imported.listUpdatedAt);
 assert.equal(h.rows.get('one')!.updatedAt,version);
 // Date-only updates are imported without touching the edit lock/version.
 h.remotes.get('1')!.update_date='2026-10-20T17:00:00+09:00';await h.tick();
 assert.equal(h.rows.get('one')!.listUpdatedAt,'2026-10-20T08:00:00.000Z');assert.equal(h.rows.get('one')!.updatedAt,version);
 // Unsent BELLO edit retains its own date when a write fails.
 h.rows.get('one')!.name='pending edit';h.rows.get('one')!.listUpdatedAt='2026-10-21T10:10:00.000Z';h.refusePatch=true;
 await h.tick();assert.equal(h.rows.get('one')!.listUpdatedAt,'2026-10-21T10:10:00.000Z');
 // A verified outbound update adopts ZAICO's visible date, not its bookkeeping date.
 const k=harness();k.seed();Object.assign(k.remotes.get('1')!,{created_at:'2024-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',update_date:'2025-01-01T00:00:00Z'});await k.run();
 k.rows.get('one')!.name='edited';k.rows.get('one')!.listUpdatedAt='2026-10-21T09:00:00.000Z';
 k.afterPatch=()=>{k.remotes.get('1')!.update_date='2026-10-21T10:00:00+09:00';};await k.tick();
 assert.equal(k.rows.get('one')!.listUpdatedAt,'2026-10-21T01:00:00.000Z');assert.equal(k.states.get('one')!.status,'OK');
 // An edit during outbound verification must retain its local timestamp.
 k.rows.get('one')!.name='first edit';k.afterPatch=()=>{k.rows.get('one')!.name='second edit';k.rows.get('one')!.listUpdatedAt='2026-10-21T10:20:00.000Z';};await k.tick();
 assert.equal(k.rows.get('one')!.name,'second edit');assert.equal(k.rows.get('one')!.listUpdatedAt,'2026-10-21T10:20:00.000Z');
 const remote=k.remotes.get('1')!;
 const command=sourceDatesUpdate('t',k.rows.get('one')!,remote,true)!;
 assert.match(command.ConditionExpression!,/updatedAt = :version/);assert.match(command.ConditionExpression!,/sourceInventoryId = :source/);
 assert.ok(!Object.values(command.ExpressionAttributeNames!).includes('updatedAt'));
 assert.deepEqual(sourceDatePatch({}, {...remote,created_at:'invalid',update_date:null,updated_at:undefined},true),{});
 const old={customFields:null,id:'z',sourceInventoryId:'2',createdAt:imported.createdAt,updatedAt:'2026-10-21T20:00:00Z',listUpdatedAt:'2024-01-01T00:00:00.000Z'};
 const recent={...old,id:'a',sourceInventoryId:'3',updatedAt:'2026-10-21T10:00:00Z',listUpdatedAt:'2026-10-20T00:00:00.000Z'};
 const defs=buildSearchFieldDefs([],{categories:[],locations:[],statuses:[]}),fields=new Map(defs.map(f=>[f.key,f]));
 assert.deepEqual([old,recent].sort(compareInventoryDateDesc).map(x=>x.id),['a','z']);
 assert.deepEqual([old,recent].sort(inventoryComparator({field:'updatedAt',direction:'desc'},fields)).map(x=>x.id),['a','z']);
 const tied={...recent,id:'b',sourceInventoryId:'10'};
 assert.deepEqual([recent,tied].sort(compareInventoryDateDesc).map(x=>x.id),['b','a']);
 assert.equal(productUpdatedAt({updatedAt:version}),version);
 assert.equal(toListRow({...old,sku:'B1',name:'old',images:[]} as any).listUpdatedAt,old.listUpdatedAt);
 assert.ok(buildScanProjection(['updatedAt']).attributes.includes('listUpdatedAt'));
 assert.equal(evaluateQuery(old,{combinator:'AND',conditions:[{id:'date',field:'updatedAt',operator:'after',value:'2026-01-01'}]},fields),false);
 const cached=[old,recent].map(x=>({...x,displayId:x.sourceInventoryId,name:x.id,sku:x.id,quantity:1,unit:'',location:'',category:'',condition:'',note:'',barcode:'',plannedSalePrice:null,thumbnailUrl:null} as InventoryItem));
 assert.deepEqual(cachedInventorySearch(cached,{},defs).map(x=>x.id),['a','z']);
 console.log('PASS source screen dates, metadata-only echo, no outbound loop, pending/concurrent edit preservation, PC/search/PWA ordering and projections');
}
main().catch(e=>{console.error(e);process.exitCode=1});

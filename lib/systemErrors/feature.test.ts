import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isExpectedFeatureError, InventorySearchLimitError } from './expectedFeature';
import { safeErrorClass } from './client';
import { normalizeSystemErrorSignal, SYSTEM_ERROR_COMPONENTS, SYSTEM_ERROR_CHECKS } from './contract';
import type { SystemErrorSignal } from './contract';
function load(path: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code, {exports, Error, TypeError, Number, performance, Promise, URL, Response, Request, Buffer, console:{warn(){},error(){}}, require:(name:string) => {
    if(name in dependencies)return dependencies[name];
    return {};
  }});
  return exports;
}
function fixture(broken = false) {
  const sent: SystemErrorSignal[] = [];
  const feature = load('./feature.ts', {'./expectedFeature':{isExpectedFeatureError},'./client':{safeErrorClass},'./server':{reportServerSystemError:async (signal:SystemErrorSignal)=>{if(broken)throw Error('transport secret');sent.push(JSON.parse(JSON.stringify(signal)));return true;}}});
  return {sent, feature};
}
test('all feature/check labels survive normalization while raw business fields are discarded', () => {
  for (const component of SYSTEM_ERROR_COMPONENTS) for (const check of SYSTEM_ERROR_CHECKS) {
    const signal = {code:'FEATURE_INVARIANT_FAILED',surface:'server',operation:'aggregate',component,check} as const;
    assert.deepEqual(normalizeSystemErrorSignal({...signal,message:'customer secret',url:'https://private/id',duration:123,amount:99}),signal);
    assert.deepEqual(normalizeSystemErrorSignal({...signal,check:'private-id'}),{code:signal.code,surface:signal.surface,operation:signal.operation,component});
  }
});
test('feature exceptions retain identity and fixed namespace, never raw error content', async () => {
  const {sent,feature}=fixture(); const problem = new TypeError('private customer url token');
  await assert.rejects(feature.observeFeatureOperation('inventory-search','search',async()=>{throw problem;}), (error:unknown)=>error===problem);
  assert.deepEqual(sent,[{code:'FEATURE_OPERATION_FAILED',check:'operation-failed',surface:'server',component:'inventory-search',operation:'search',errorClass:'TypeError'}]);
});
test('expected auth/rate/validation/conflict and cancelled operations do not dispatch', async () => {
  const {sent,feature}=fixture();
  for(const status of [401,403,429]) assert.equal(await feature.reportFeatureError({status,message:'secret'},'partner-sharing','share'),false);
  for(const name of ['AbortError','ThrottlingException','NoValidAuthTokens']) assert.equal(await feature.reportFeatureError(Object.assign(Error('secret'),{name}),'inventory-images','fetch'),false);
  assert.equal(sent.length,0);
});
test('slow success emits only labels; fast, failed, non-success and disabled timing stay silent', async () => {
  const {sent,feature}=fixture();let time=0;const now=()=>time;
  const result={private:'customer'};
  assert.equal(await feature.observeFeatureOperation('inventory-analysis','aggregate',async()=>{time=11000;return result;},{now}),result);
  assert.deepEqual(sent,[{code:'FEATURE_SLOW_OPERATION',check:'slow-response',surface:'server',component:'inventory-analysis',operation:'aggregate'}]);
  sent.length=0;
  for(const slowMs of [NaN,Infinity,-1,0]) await feature.observeFeatureOperation('inventory-analysis','aggregate',async()=>{time+=99999;return result;},{now,slowMs});
  await feature.observeFeatureOperation('inventory-analysis','aggregate',async()=>{time+=99999;return result;},{now,successful:()=>false});
  assert.equal(sent.length,0);
});
test('broken reporting preserves original successful results and errors', async () => {
  const {feature}=fixture(true);const error=new Error('original');let time=0;
  await assert.rejects(feature.observeFeatureOperation('inventory-search','search',async()=>{throw error;}),(value:unknown)=>value===error);
  assert.equal(await feature.observeFeatureOperation('inventory-search','search',async()=>{time=99999;return 7;},{now:()=>time}),7);
});
function nextResponse(){return {NextResponse:{json:(body:unknown,options?:ResponseInit)=>Response.json(body,options)}};}
test('actual ledger route excludes denied and invalid-year requests, reports read/workbook failures once', async () => {
  const {feature,sent}=fixture();let calls=0,role='ADMIN',ok=true,failWorkbook=false;
  const route=load('../../app/api/inventory/used-goods-ledger/route.ts',{'@/lib/systemErrors/feature':feature,'next/server':nextResponse(),'@/lib/mobile/session':{getMobileSession:async()=>({ok,role,status:401})},'@/lib/inventory/usedGoodsLedger':{ledgerYear:(value:string)=>{if(value!=='2026')throw Error('invalid');return 2026;}},'@/lib/inventory/usedGoodsLedgerSource':{loadUsedGoodsLedger:async()=>{calls++;if(!failWorkbook)throw new TypeError('customer-secret');return {rows:[]};}},'@/lib/inventory/usedGoodsLedgerWorkbook':{usedGoodsLedgerWorkbook:async()=>{throw Error('private workbook');}}});
  const request=(query='year=2026')=>new Request('https://example.invalid/api?'+query);
  ok=false;assert.equal((await route.GET(request())).status,401);ok=true;role='STAFF';assert.equal((await route.GET(request())).status,403);role='ADMIN';assert.equal((await route.GET(request('year=bad'))).status,400);assert.equal(calls,0);assert.equal(sent.length,0);
  assert.equal((await route.GET(request())).status,503);assert.equal(sent.length,1);assert.equal(sent[0].component,'antique-ledger');
  sent.length=0;failWorkbook=true;assert.equal((await route.GET(request('year=2026&format=xlsx'))).status,503);assert.equal(sent.length,1);
});
test('actual public catalog route skips domain denials and reports unexpected service failures', async () => {
  const {feature,sent}=fixture();class CatalogError extends Error {constructor(public status:number,public diagnostic='expected'){super('private token');}}
  let failure:unknown=new CatalogError(403);
  const route=load('../../app/api/shared-inventory/[token]/route.ts',{'@/lib/systemErrors/feature':feature,'next/server':nextResponse(),'@/lib/inventory/partnerCatalog/grants':{CatalogError},'@/lib/inventory/partnerCatalog/server':{partnerCatalogResponseHeaders:{},partnerCatalogServer:()=>({read:async()=>{throw failure;}}),catalogFailure:(error:unknown)=>({status:error instanceof CatalogError?error.status:503,error:'safe'})}});
  const run=()=>route.GET(new Request('https://example.invalid'),{params:Promise.resolve({token:'private'})});
  assert.equal((await run()).status,403);assert.equal(sent.length,0);failure=new CatalogError(503);assert.equal((await run()).status,503);assert.equal(sent.length,0);failure=new CatalogError(503,'stored-grant-invalid');assert.equal((await run()).status,503);assert.equal(sent.length,1);sent.length=0;failure=new TypeError('private token');assert.equal((await run()).status,503);assert.equal(sent.length,1);assert.equal(sent[0].component,'partner-sharing');
});
test('actual analytics seam observes load failures but leaves missing snapshots silent', async()=>{
  const {feature,sent}=fixture();let status='missing',allowed=true;
  const server=load('../inventory/analysis/server.ts',{'@/lib/systemErrors/feature':feature,'@/lib/amplify/requireInventoryUser':{getVerifiedInventoryAccess:async()=>({kind:'authorized',owner:'owner',role:'ADMIN'})},'../mutationSession':{inventoryVerifiedReadSession:async()=>allowed?{owner:'owner',role:'ADMIN'}:null},'../e2eFixtures':{isE2EFixtureModeActive:()=>false},'../categoryPersistence':{inventoryDdb:{},inventoryTable:()=> 'fixture'},'./reader':{loadAnalysis:async()=>({status}),createAnalysisReader:(deps:any)=>({summary:async(request:unknown)=>await deps.authorize()?deps.load(request):{status:'error'}})}});
  const reader=server.createAuthorizedAnalysisReader();await reader.summary({target:'sales'});assert.equal(sent.length,0);status='error';allowed=false;await reader.summary({target:'sales'});assert.equal(sent.length,0);allowed=true;await reader.summary({target:'sales'});assert.equal(sent.length,1);assert.equal(sent[0].component,'sales-analysis');sent.length=0;await reader.summary({target:'inventory'});assert.equal(sent[0].component,'inventory-analysis');
});
test('actual photo action reports internal domain result once and skips expected input failures',async()=>{
  const {feature,sent}=fixture();let error='INVALID_INPUT';
  const actions=load('../../app/actions/photoRegistration.ts',{'@/lib/systemErrors/feature':feature,'@/lib/photoRegistration/webAdapter':{getPhotoRegistrationWebAdapter:()=>({listPrimaryPhotoThumbnails:async()=>({ok:false,error,message:'private source url'})}),getWebTrustedClaims:async()=>({sub:'private'})}});
  await actions.listInventoryPrimaryPhotoThumbnailsAction(['private-id']);assert.equal(sent.length,0);error='INTERNAL_ERROR';const result=await actions.listInventoryPrimaryPhotoThumbnailsAction(['private-id']);assert.equal(result.ok,false);assert.equal(sent.length,1);assert.equal(sent[0].component,'inventory-images');assert.ok(!JSON.stringify(sent).includes('private'));
});
test('actual inventory search engines report one final failure after fast/fallback paths and preserve exception', async()=>{
  const {feature,sent}=fixture();const error=new TypeError('private query and customer');let fixtureMode=true;
  const page={items:[],total:0,totalQuantity:0,offset:0,limit:20};
  const queries=load('../inventory/queries.ts',{'@/lib/systemErrors/feature':feature,'@/lib/amplify/requestCache':{requestCache:(fn:unknown)=>fn},'./e2eFixtures':{isE2EFixtureModeActive:()=>fixtureMode,e2eListPage:()=>page},'@/lib/inventory/mutationSession':{inventoryVerifiedReadSession:async()=>null},'@/lib/amplify/dataClient':{serverDataClient:{models:{Inventory:{list:async()=>{throw error;}}}}}});
  assert.equal(await queries.listInventorySimpleSearch({q:'private query'},{offset:0,limit:20}),page);assert.equal(sent.length,0);fixtureMode=false;
  for(const run of [()=>queries.listInventory({}, {offset:0,limit:20}),()=>queries.listInventorySimpleSearch({q:'private'}, {offset:0,limit:20}),()=>queries.listInventoryAdvanced({},new Map(),{offset:0,limit:20}),()=>queries.listInventoryMobileSearch({advanced:{},sort:{}},new Map(),{offset:0,limit:20})]) {
    sent.length=0;await assert.rejects(run(),(value:unknown)=>value===error);assert.equal(sent.length,1);assert.equal(sent[0].component,'inventory-search');
  }
});
test('actual analysis reader observer retains error identity; throttling stays out of repair',async()=>{
  const {feature,sent}=fixture();const reader=load('../inventory/analysis/reader.ts',{'@aws-sdk/lib-dynamodb':{GetCommand:class {constructor(public input:unknown){}}}});
  let error:unknown=Object.assign(Error('private AWS body'),{name:'ThrottlingException'}),observed:unknown;
  const run=()=>reader.loadAnalysis({send:async()=>{throw error;}},'fixture',{target:'sales'},0,async(value:unknown)=>{observed=value;await feature.reportFeatureError(value,'sales-analysis','aggregate');});
  assert.equal((await run()).status,'error');assert.equal(observed,error);assert.equal(sent.length,0);error=new TypeError('private manifest');assert.equal((await run()).status,'error');assert.equal(sent.length,1);
});

test('internal SDK validation failures are repairs, while explicit boundary validation stays silent', async()=>{
 const {feature,sent}=fixture();
 await feature.reportFeatureError(Object.assign(Error('Invalid ProjectionExpression customer secret'),{name:'ValidationException',statusCode:400}),'inventory-search','search');
 assert.equal(sent.length,1);assert.equal(sent[0].errorClass,'Unknown');assert.ok(!JSON.stringify(sent).includes('ProjectionExpression'));
});

test('actual oversized collection rejects partial results without repair, and name spoofing is not trusted',async()=>{
 const {feature,sent}=fixture();let reads=0;
 const queries=load('../inventory/queries.ts',{'@/lib/systemErrors/feature':feature,'@/lib/systemErrors/expectedFeature':{InventorySearchLimitError},'./searchBounds':{MAX_SEARCH_CANDIDATES:2},'@/lib/amplify/requestCache':{requestCache:(fn:unknown)=>fn},'./e2eFixtures':{isE2EFixtureModeActive:()=>false},'@/lib/inventory/mutationSession':{inventoryVerifiedReadSession:async()=>null},'@/lib/amplify/dataClient':{serverDataClient:{models:{Inventory:{list:async()=>{reads++;return {data:[{id:'fixture-a',quantity:1},{id:'fixture-b',quantity:1}],nextToken:'more-fixture-records'};}}}}},'./imageTypes':{resolveTopImage:()=>null,normalizeImageRecord:(value:unknown)=>value},'./inventoryId':{resolveDisplayInventoryId:()=> 'fixture'},'./categories':{inventoryCategoryIds:()=>[]},'./customFieldsCodec':{parseCustomFields:()=>null}});
 await assert.rejects(queries.listInventorySimpleSearch({q:'fixture'},{offset:0,limit:20}),(error:unknown)=>error instanceof InventorySearchLimitError);assert.equal(reads,2,'initial projection and fallback both retain the processing guard');assert.equal(sent.length,0);
 const spoof=Object.assign(new Error('internal programming problem'),{name:'InventorySearchLimitError'});assert.equal(await feature.reportFeatureError(spoof,'inventory-search','search'),true);assert.equal(sent.length,1);
});

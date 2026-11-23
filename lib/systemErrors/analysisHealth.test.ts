import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as actualReader from '../inventory/analysis/reader';
import { inspectAnalysisHealth } from './health';
import type { AnalysisBuild } from '../inventory/analysis/types';

const asOf = '2026-11-23T00:00:00.000Z';
function build(): AnalysisBuild {
  return {metadata:{version:1,generation:asOf,asOf,timezone:'Asia/Tokyo',scopeId:'synthetic',amountBasis:'synthetic',metadataVersions:{},coverageStart:'2026-11-01',coverageEnd:'2026-11-23',accuracy:'captured-current-source',sourceRecordCount:0,unlocatedAcquisitionRecords:0,inventorySkuVersion:1},inventoryValue:{version:2,asOf,total:0,quantity:0,count:0,groups:[],other:[],issues:[],issueCount:0,excluded:[],unpricedCount:0},categories:[],inventory:[],sales:[],acquisitions:[],retailReference:[],referenceExclusions:{unknownChannel:0,unknownCost:0,unverifiedOrigin:0,excluded:0,salesAmount:0}} as unknown as AnalysisBuild;
}
function setup() {
  const checks: string[] = [], failures: string[] = [];
  const state = {build:build(),status:'ok',authorized:true,observerThrows:false};
  const dependencies: Record<string, unknown> = {
    'server-only':{},
    '@/lib/systemErrors/feature':{
      observeFeatureOperation:async (_component:unknown,_operation:unknown,run:()=>unknown)=>run(),
      reportFeatureError:async (_error:unknown,component:string)=>{failures.push(component);},
    },
    '@/lib/systemErrors/health':{inspectAnalysisHealth},
    '@/lib/systemErrors/healthReporting':{reportFeatureChecks:async (_component:unknown,_operation:unknown,values:string[])=>{if(state.observerThrows)throw Error('report failed');checks.push(...values);}},
    '@/lib/amplify/requireInventoryUser':{getVerifiedInventoryAccess:async()=>({kind:state.authorized?'authorized':'denied',owner:'synthetic',role:'ADMIN'})},
    '../categoryPersistence':{inventoryDdb:{},inventoryTable:()=> 'synthetic'},
    '../mutationSession':{inventoryVerifiedReadSession:async()=>({owner:'synthetic',role:'ADMIN'})},
    '../e2eFixtures':{isE2EFixtureModeActive:()=>false},
    '../listImageUrls':{},'./metadata':{},
    './reader':{...actualReader,loadAnalysis:async()=>state.status==='ok'?{status:'ok',build:state.build}:{status:state.status}},
  };
  const output: Partial<typeof import('../inventory/analysis/server')> = {};
  const source=fs.readFileSync(new URL('../inventory/analysis/server.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{exports:output,Date,require:(name:string)=>{assert.ok(name in dependencies,`Unstubbed dependency: ${name}`);return dependencies[name];}});
  assert.ok(output.createAuthorizedAnalysisReader);
  return {state,checks,failures,reader:output.createAuthorizedAnalysisReader()};
}

test('actual authorized analytics path checks a computed summary and never checks raw load or detail output',async()=>{
  const {reader,checks,failures}=setup();
  assert.equal((await reader.summary({target:'inventory'})).status,'ok');
  assert.equal((await reader.detail({target:'inventory',generation:asOf})).status,'ok');
  assert.deepEqual(checks,[]);assert.deepEqual(failures,[]);
});
test('a current-snapshot total discrepancy is reported after actual aggregation',async()=>{
  const {reader,state,checks,failures}=setup();state.build.inventoryValue.total=1;
  assert.equal((await reader.summary({target:'inventory'})).status,'ok');
  assert.deepEqual(checks,['aggregate-total-mismatch']);assert.deepEqual(failures,[]);
});
test('actual aggregate computation defects are observed, while malformed caller cursors are not',async()=>{
  const {reader,state,checks,failures}=setup();
  assert.equal((await reader.detail({target:'inventory',generation:asOf,cursor:'%invalid'})).status,'error');
  assert.deepEqual(failures,[]);
  state.build.inventory=null as unknown as AnalysisBuild['inventory'];
  assert.equal((await reader.summary({target:'inventory'})).status,'error');
  assert.deepEqual(failures,['inventory-analysis']);assert.deepEqual(checks,[]);
});
test('expected missing, expired, denied and invalid-input reads do not create repair incidents',async()=>{
  const {reader,state,checks,failures}=setup();
  for(const status of ['missing','expired']){state.status=status;assert.equal((await reader.summary({target:'inventory'})).status,status);}
  state.status='ok';state.authorized=false;await reader.summary({target:'inventory'});
  state.authorized=true;await reader.summary({target:'not-a-target'});
  assert.deepEqual(checks,[]);assert.deepEqual(failures,[]);
});
test('an invariant observer failure cannot replace a successful business result',async()=>{
  const {reader,state}=setup();state.observerThrows=true;
  assert.equal((await reader.summary({target:'inventory'})).status,'ok');
});

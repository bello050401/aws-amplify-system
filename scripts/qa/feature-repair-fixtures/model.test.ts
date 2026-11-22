import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {computeFeatureFixture,changedInput,scopes} from './model';
import {buildFeatureFixture} from './build';
const expected={
 'procurement-yahoo-local':[{quantity:2,unitPrice:5500,total:11000},{quantity:4,unitPrice:2750,total:11000}],
 'procurement-trefac-local':[{quantity:2,unitPrice:6050,total:12100},{quantity:4,unitPrice:3025,total:12100}],
 'procurement-restage-local':[{quantity:2,unitPrice:5940},{quantity:4,unitPrice:2970}],
 'inventory-search-local':[{names:['サンプル椅子'],quantity:2},{names:['サンプル机'],quantity:1}],
 'inventory-images-local':[{selected:'A',thumbnail:'inventory/fixture-A-thumb.svg'},{selected:'B',thumbnail:'inventory/fixture-B-thumb.svg'}],
 'partner-sharing-local':[{count:1,name:'サンプル椅子',quantity:2},{count:0,name:null,quantity:0}],
 'sales-analysis-local':[{amount:15000,quantity:3,categoryAmount:15000},{amount:25000,quantity:5,categoryAmount:25000}],
 'inventory-analysis-local':[{amount:15000,quantity:3,categoryAmount:15000},{amount:25000,quantity:5,categoryAmount:25000}],
 'antique-ledger-local':[{rowCount:1,quantity:2,total:21000},{rowCount:1,quantity:4,total:21000}],
};
for(const scope of scopes)test(`real ${scope} model recomputes changed synthetic input and resets baseline`,()=>{
 assert.deepEqual(computeFeatureFixture(scope).actual,expected[scope][0]);assert.deepEqual(computeFeatureFixture(scope,changedInput(scope)).actual,expected[scope][1]);assert.deepEqual(computeFeatureFixture(scope).actual,expected[scope][0]);
});
test('all fixed-scope browser bundles build with frozen manifest and outside-network CSP',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'bello-feature-fixture-'));
 try{for(const scope of scopes){const output=path.join(dir,scope),manifest=await buildFeatureFixture(scope,output);assert.deepEqual(manifest.baseline,expected[scope][0]);assert.deepEqual(manifest.mutated,expected[scope][1]);assert.equal(manifest.scopeId,scope);assert.equal(manifest.operationalApproval,false);const html=await readFile(path.join(output,'index.html'),'utf8'),bundle=await readFile(path.join(output,'fixture.js'),'utf8');assert.ok(html.includes("connect-src 'self'"));assert.ok(html.includes("img-src 'none'"));assert.ok(bundle.includes('/__feature-check'));assert.ok(!bundle.includes('NATIVE_FIXTURE_HASHING_UNAVAILABLE'),'unused Node hashing must be tree-shaken');assert.ok(!bundle.includes('__BELLO_FEATURE_SCOPE__'));}}
 finally{await rm(dir,{recursive:true,force:true});}
});

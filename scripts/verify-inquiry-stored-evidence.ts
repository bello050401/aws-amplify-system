import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storedReplyEvidence} from '../lib/inquiry/storedEvidence';

test('legacy draft opens with missing candidate and source arrays',()=>{
 const value=storedReplyEvidence(JSON.stringify({product:{name:'旧商品'},runtimeProof:{generatedAt:new Date().toISOString()}}))!;
 assert.deepEqual(value.productCandidates.map(p=>p.inventoryId),[]);assert.deepEqual(value.externalFacts,[]);
 assert.equal(value.product?.name,'旧商品');assert.equal(value.runtimeProof,undefined);
});
test('malformed historical evidence does not crash or create delivery proof',()=>{
 for(const value of [null,undefined,'not-json','[]',42])assert.equal(storedReplyEvidence(value),null);
 const result=storedReplyEvidence({productCandidates:[null,{inventoryId:'a',name:'A',reasons:null}],externalFacts:[null],runtimeProof:{}})!;
 assert.deepEqual(result.productCandidates,[]);assert.deepEqual(result.externalFacts,[]);assert.equal(result.runtimeProof,undefined);
});
test('current complete evidence and proof are preserved without changing their content',()=>{
 const current={productCandidates:[{inventoryId:'a',name:'A',reasons:['同一ID']}],inventoryFieldsUsed:[],knowledgeDocuments:[],externalFacts:[{field:'width',value:'71.5'}],unresolvedFacts:[],runtimeProof:{conversationStamp:'sha',generatedAt:'2026-11-08T00:00:00Z'}};
 assert.deepEqual(storedReplyEvidence(current),current);
});

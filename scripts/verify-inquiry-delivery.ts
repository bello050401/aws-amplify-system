import assert from 'node:assert/strict';
import {evaluatedDeliveryAllowed,transportOutcome,recentDraftProof,deliveryJobId,type DeliveryPolicy} from '../lib/inquiry/runtime/deliveryPolicy';
const evaluation={version:'qa-1',reviewer:'qa-reviewer',cases:50,wrongProduct:0,wrongRecipient:0,duplicates:0,ungroundedPromises:0,factCorrectRate:.94,identificationRate:.92};
const base:DeliveryPolicy={mode:'AUTO',approvedIntents:['general'],evaluation};
let count=0;function test(name:string,fn:()=>void){fn();count++;console.log('PASS '+name);}
test('評価済み種類だけ自動送信可',()=>{assert(evaluatedDeliveryAllowed(base,['general'],false));assert(!evaluatedDeliveryAllowed(base,['other'],false));});
test('下書き公開は手動でも送信不可',()=>assert(!evaluatedDeliveryAllowed({...base,mode:'DRAFT'},['general'],true)));
test('確認方式で自動送信しない',()=>{assert(!evaluatedDeliveryAllowed({...base,mode:'REVIEW'},['general'],false));assert(evaluatedDeliveryAllowed({...base,mode:'REVIEW'},['general'],true));});
for(const [key,value] of Object.entries({reviewer:'',version:'',cases:49,wrongProduct:1,wrongRecipient:1,duplicates:1,ungroundedPromises:1,factCorrectRate:.89,identificationRate:.89}))test('評価未達 '+key,()=>assert(!evaluatedDeliveryAllowed({...base,evaluation:{...evaluation,[key]:value}},['general'],true)));
for(const value of [NaN,Infinity,-1,1.1])test('不正な評価値 '+value,()=>assert(!evaluatedDeliveryAllowed({...base,evaluation:{...evaluation,factCorrectRate:value}},['general'],false)));
for(const [status,proof,expected] of [[200,true,'ACCEPTED'],[200,false,'UNKNOWN'],[409,true,'ACCEPTED'],[409,false,'UNKNOWN'],[429,false,'REJECTED'],[500,false,'UNKNOWN'],[401,false,'REJECTED']] as const)test('受付判定 '+status+'/'+proof,()=>assert.equal(transportOutcome(status,proof),expected));
test('下書き時刻の期限・未来・不正値',()=>{const now=Date.now();assert(recentDraftProof(new Date(now-299000).toISOString(),now));for(const t of ['invalid',new Date(now-301000).toISOString(),new Date(now+31000).toISOString()])assert(!recentDraftProof(t,now));});
test('送信予約の重複キーは同じ版・宛先に固定',()=>{assert.equal(deliveryJobId('c','m','d','v','to'),deliveryJobId('c','m','d','v','to'));assert.notEqual(deliveryJobId('c','m','d','v','to'),deliveryJobId('c','m','d','v','other'));});
console.log(JSON.stringify({passed:count,customerTransmissions:0}));

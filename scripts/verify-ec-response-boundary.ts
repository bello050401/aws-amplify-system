import assert from "node:assert/strict";
import { isExpectedEcReview, type EcReview } from "../lib/listing/ecManagement";
const expected={inventoryId:"test",channel:"YAHOO",operation:"PUBLISH"} as const;
const good:EcReview={...expected,title:"Test",message:"Ready",status:"READY",token:"proof"};
assert.equal(isExpectedEcReview(good,expected),true);
for(const response of [undefined,null,{},false,{...good,inventoryId:"other"},{...good,channel:"BASE"},{...good,operation:"STOP"},{...good,token:undefined},{...good,status:"INVALID"},{...good,nextAt:NaN}])assert.equal(isExpectedEcReview(response,expected),false);
assert.equal(isExpectedEcReview({...good,status:"DONE",token:undefined},expected),true);
assert.equal(isExpectedEcReview({...good,status:"WAIT",token:undefined,nextAt:Date.now()+1000},expected),true);
console.log("PASS: absent, malformed and mismatched EC responses fail closed without discarding the last valid review");

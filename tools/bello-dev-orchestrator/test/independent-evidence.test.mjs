import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateEvidence} from '../src/review/evidenceGate.mjs';
const report={status:'completed',tests:[{name:'Host only',result:'skipped'}],commandsRun:[],changes:[]};
const valid={passed:true,receipt:{passed:true,results:[{passed:true,exitCode:0}]}};
test('host-verified tests satisfy evidence without fabricated Agent test claims',()=>{
 assert.equal(evaluateEvidence({report,independentVerification:valid}).passed,true);
 assert.equal(report.tests[0].result,'skipped');
 assert.equal(evaluateEvidence({report}).passed,false);
});
test('stale, failed, empty or self-reported independent evidence does not pass',()=>{
 for(const independentVerification of [{...valid,passed:false},{passed:true},{passed:true,receipt:{passed:true,results:[]}},{passed:true,receipt:{passed:true,results:[{passed:true,exitCode:1}]}}]) assert.equal(evaluateEvidence({report,independentVerification}).passed,false);
 assert.equal(evaluateEvidence({report:{...report,independentVerification:valid}}).passed,false);
 assert.equal(evaluateEvidence({report:{...report,tests:[{result:'failed'}]},independentVerification:valid}).passed,false);
});

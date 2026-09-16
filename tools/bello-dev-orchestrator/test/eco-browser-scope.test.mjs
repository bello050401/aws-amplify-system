import test from 'node:test';
import assert from 'node:assert/strict';
import {runQaSession} from '../src/eco/browserWorker.mjs';
import {scopedClaudeConfig} from '../src/eco/serviceBindings.mjs';

test('dedicated implementation discards inherited broad tools and external integrations',()=>{
  const source={claude:{model:'sonnet',permissionMode:'acceptEdits',allowedTools:['Bash','Read'],extraArgs:['--dangerously-skip-permissions']}};
  const scoped=scopedClaudeConfig(source,'sonnet',['index.html']);
  assert.deepEqual(scoped.claude.allowedTools,['Read(./index.html)','Edit(./index.html)','Write(./index.html)']);
  assert.equal(scoped.claude.permissionMode,'dontAsk');
  assert.ok(scoped.claude.disallowedTools.includes('Bash'));
  assert.ok(scoped.claude.extraArgs.includes('--strict-mcp-config'));
  assert.ok(!scoped.claude.extraArgs.includes('--dangerously-skip-permissions'));
  assert.equal(source.claude.permissionMode,'acceptEdits');
  assert.throws(()=>scopedClaudeConfig(source,'sonnet',['../secret']),/Invalid scoped/);
});

for(const target of ['https://qa.example.test:444/staging/', 'https://qa.example.test/production/', 'https://qa.example.test/staging-extra/', 'https://other.example.test/staging/']) {
  test(`browser blocks out-of-scope request ${target}`, async()=>{
    let handler, aborted=false;
    const page={route:async(_,fn)=>{handler=fn;},goto:async()=>handler({request:()=>({url:()=>target,method:()=> 'GET'}),abort:()=>{aborted=true;},continue:()=>{throw Error('Unexpected network authorization');}}),url:()=> 'https://qa.example.test/staging/'};
    await assert.rejects(runQaSession({page,sequence:[{type:'navigate'},{type:'reload'}],baseUrl:'https://qa.example.test/staging/',allowedDomains:['qa.example.test','other.example.test'],staticSmoke:true}),/Disallowed network/);
    assert.equal(aborted,true);
  });
}

test('browser blocks a redirect outside the configured path even without a network callback', async()=>{
  const page={route:async()=>{},goto:async()=>{},url:()=> 'https://qa.example.test/production/'};
  await assert.rejects(runQaSession({page,sequence:[{type:'navigate'},{type:'reload'}],baseUrl:'https://qa.example.test/staging/',allowedDomains:['qa.example.test'],staticSmoke:true}),/left the allowed/);
});

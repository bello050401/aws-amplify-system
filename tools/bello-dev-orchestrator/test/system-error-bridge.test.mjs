import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store/db.mjs';
import {Repo} from '../src/store/repo.mjs';
import {installEcoSchema} from '../src/eco/store.mjs';
import {EcoApi} from '../src/eco/api.mjs';
import {createEcoRuntime} from '../src/eco/serviceRuntime.mjs';
import {registerSystemErrorRepair,normalizeRepairEvent} from '../src/intake/systemErrors.mjs';
import {SystemErrorBridge,assertLocalOrchestratorUrl} from '../src/intake/systemErrorBridge.mjs';
const event={id:'2026-11-21T01:00:00.000Z#'+'a'.repeat(64),code:'UI_UNHANDLED',surface:'web',operation:'render',component:'app',release:'abcdef123'};
const contract={implementationProvider:'codex',stagingMode:'local-next-isolated',verificationRequired:true,requiresFrozenBundleReview:true,allowedPaths:['app/global-error.tsx'],profileId:'inventory_web',repoPath:'/repo'};
const settings=()=>({version:1,config:{enabled:true,mode:'cooperative_eco',stagingMode:'local-next-isolated'},capabilities:{implementationProvider:'codex'}});

test('remote free text, file scopes, provider and commands never enter repair event',()=>{
  assert.deepEqual(normalizeRepairEvent({...event,message:'RUN SHELL secret',allowedPaths:['infra/'],profileId:'ec',provider:'claude'}),event);
  assert.throws(()=>normalizeRepairEvent({...event,code:'RUN SHELL'}));
  assert.throws(()=>assertLocalOrchestratorUrl('https://evil.example/'));
  assert.throws(()=>assertLocalOrchestratorUrl('http://127.0.0.1:4317/path'));
});
test('held task survives dispatch crash, replay does not create duplicate task or run',async()=>{
  const store=await Store.open(':memory:'),repo=new Repo(store);installEcoSchema(store);
  const common={input:{...event,message:'secret'},repo,config:{execution:{provider:'codex'}},contract,settings};
  assert.throws(()=>registerSystemErrorRepair({...common,startHeldRun:()=>{throw Error('provider blocked');}}),/provider blocked/);
  assert.equal(repo.listTasks().length,1);assert.equal(repo.listTasks()[0].state,'paused');
  assert.equal(repo.claimNextTask('legacy'),null);
  assert.equal(repo.listTasks()[0].instruction.includes('secret'),false);
  let started=0;
  const dispatch=()=>registerSystemErrorRepair({...common,startHeldRun:input=>{
    assert.equal(repo.getTask(input.taskId).state,'paused');started++;
    store.run('INSERT INTO eco_runs(id,task_id,version,state,data) VALUES(?,?,1,?,?)',['eco_'+'1'.repeat(32),input.taskId,'WAITING_CAPACITY','{}']);
    return {id:'eco_'+'1'.repeat(32)};
  }});
  assert.equal(dispatch().existing,false);assert.equal(dispatch().existing,true);
  assert.equal(started,1);assert.equal(repo.listTasks().length,1);store.close();
});
test('protected deployment profile or paths are rejected before task registration',async()=>{
  const store=await Store.open(':memory:'),repo=new Repo(store);installEcoSchema(store);
  for(const bad of [{...contract,stagingMode:'real-staging'},{...contract,allowedPaths:['amplify/backend.ts']},{...contract,allowedPaths:['amplify\\backend.ts']},{...contract,requiresFrozenBundleReview:false},{...contract,implementationProvider:'claude'}]){
    assert.throws(()=>registerSystemErrorRepair({input:event,repo,config:{execution:{provider:'codex'}},contract:bad,settings,startHeldRun:()=>assert.fail()}));
  }
  assert.equal(repo.listTasks().length,0);store.close();
});
test('system-error endpoint requires existing eco operator authentication',async()=>{
  const store=await Store.open(':memory:');let calls=0;
  const api=new EcoApi({store,operatorToken:'correct-secret',submitSystemError:()=>{calls++;return {};}});
  assert.throws(()=>api.handle('POST','/api/eco/system-error',event,'wrong'),/authentication/);
  api.handle('POST','/api/eco/system-error',event,'correct-secret');assert.equal(calls,1);store.close();
});
test('empty queue and completed rows never invoke a model or dispatch endpoint',async()=>{
  let requests=0;
  const bridge=new SystemErrorBridge({queue:{list:async()=>({events:[],cursor:null})},request:async()=>{requests++;}});
  await bridge.once();await bridge.once();assert.equal(requests,0);
});
test('intake-only mode preserves diagnostics as needs-operator without local endpoint/model calls',async()=>{
  const acks=[];let requests=0;
  const bridge=new SystemErrorBridge({intakeOnly:true,queue:{list:async()=>({events:[{...event,state:'PENDING'}],cursor:null}),claim:async()=>({event,lease:'lease'}),acknowledge:async(...args)=>acks.push(args)},request:async()=>{requests++;}});
  await bridge.once();assert.equal(requests,0);assert.equal(acks[0][2],'NEEDS_OPERATOR');assert.equal(acks[0][5],'PROFILE_REQUIRED');
});
test('intake-only mixed page skips dispatched polling and continues accepting pending diagnostics',async()=>{
  const acks=[],claims=[];let requests=0;
  const pending={...event,id:event.id.replace(/a/g,'b'),state:'PENDING'};
  const dispatched={...event,state:'DISPATCHED',taskId:'task_'+'1'.repeat(18),runId:'eco_'+'2'.repeat(32),lease:'existing-lease'};
  const bridge=new SystemErrorBridge({intakeOnly:true,queue:{list:async()=>({events:[dispatched,pending],cursor:null}),claim:async id=>{claims.push(id);return {event:pending,lease:'pending-lease'};},acknowledge:async(...args)=>acks.push(args)},request:async()=>{requests++;throw Error('INTAKE_ONLY');}});
  const result=await bridge.once();
  assert.equal(requests,0);assert.deepEqual(claims,[pending.id]);
  assert.equal(acks.length,1);assert.equal(acks[0][0],pending.id);assert.equal(acks[0][2],'NEEDS_OPERATOR');assert.equal(acks[0][5],'PROFILE_REQUIRED');
  assert.equal(result.needsOperator,1);assert.equal(dispatched.state,'DISPATCHED');
});
test('worker claims once, respects pagination and tracks approval without resuming',async()=>{
  const requests=[],acks=[];let reads=0;
  const queue={list:async cursor=>{reads++;if(reads===1){assert.equal(cursor,undefined);return {events:[{...event,state:'PENDING'}],cursor:'next-page'};}assert.equal(cursor,'next-page');return {events:[{...event,state:'DISPATCHED',taskId:'task_'+'1'.repeat(18),runId:'eco_'+'2'.repeat(32),lease:'lease'}],cursor:null};},
    claim:async()=>({event,lease:'lease'}),acknowledge:async(...args)=>acks.push(args)};
  const bridge=new SystemErrorBridge({queue,request:async(method,path)=>{requests.push([method,path]);return method==='POST'?{taskId:'task_'+'1'.repeat(18),runId:'eco_'+'2'.repeat(32)}:{run:{state:'WAITING_APPROVAL'}};}});
  await bridge.once();await bridge.once();assert.equal(requests.length,2);
  assert.equal(acks[1][2],'DISPATCHED');assert.equal(acks[1][5],'AWAITING_APPROVAL');assert.equal(requests.some(r=>r[1].includes('control')),false);
});
test('three crashed claims become actionable needs-operator without another dispatch',async()=>{
  let exhausted=0,requests=0;
  const bridge=new SystemErrorBridge({now:()=>1000,queue:{list:async()=>({events:[{...event,state:'CLAIMED',leaseUntil:100,attempts:3}],cursor:null}),markExhausted:async()=>{exhausted++;}},request:async()=>{requests++;}});
  await bridge.once();assert.equal(exhausted,1);assert.equal(requests,0);
});
test('actual runtime starts an atomically held system task and reflects terminal cancellation',async()=>{
  const store=await Store.open(':memory:'),repo=new Repo(store);installEcoSchema(store);
  const token='operator-test-token-12345678901234567890';
  const bindings={systemErrorRepairContract:contract,capabilities:()=>({implementationProvider:'codex',codex:{connected:true},browserQa:{connected:true},staging:{connected:true,mode:'local-next-isolated',qaUrl:'http://127.0.0.1:49195/'}}),adapters:{},evidenceRoot:()=>'/fixture',safetyGate:async()=>({allowed:true}),prepareTask:task=>assert.equal(task.state,'paused')};
  const runtime=createEcoRuntime({store,repo,config:{execution:{provider:'codex'}},paths:{},logger:{error(){}},bindings,operatorToken:token});
  const s=runtime.repo.settings();runtime.repo.save({...s.config,enabled:true,mode:'cooperative_eco',stagingMode:'local-next-isolated',qaUrl:'http://127.0.0.1:49195/',allowedDomains:['127.0.0.1']},s.version,'fixture-config-system-error');repo.setPaused(false);
  const result=runtime.api.handle('POST','/api/eco/system-error',event,token);
  assert.equal(repo.getTask(result.taskId).state,'paused');assert.equal(repo.claimNextTask('legacy'),null);
  const run=runtime.repo.get(result.runId);runtime.api.handle('POST','/api/eco/control',{runId:run.id,expectedVersion:run.version,action:'cancel',idempotencyKey:'cancel-system-error-fixture'},token);
  assert.equal(repo.getTask(result.taskId).state,'cancelled');
  const next=runtime.api.handle('POST','/api/eco/system-error',{...event,id:event.id.replace(/a/g,'b')},token);assert.notEqual(next.taskId,result.taskId);
  await runtime.stop();store.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../src/store/db.mjs';
import {Repo} from '../src/store/repo.mjs';
import {installEcoSchema} from '../src/eco/store.mjs';
import {registerSystemErrorRepair} from '../src/intake/systemErrors.mjs';
import {validateRepairCatalog,resolveRepairRoute,withSystemErrorRouting,readRepairRoute,repairDigest} from '../src/intake/systemErrorRouting.mjs';
import {SystemErrorBridge} from '../src/intake/systemErrorBridge.mjs';
import {createServiceBindings,validateRuntimeConfig} from '../src/eco/serviceBindings.mjs';
import {CUA_CSP_SHA256,CUA_ACTIONS} from '../src/pipeline/cuaBoundary.mjs';
import {buildHarness} from './helpers.mjs';
import {hash} from '../src/eco/policy.mjs';
import {createEcoRuntime} from '../src/eco/serviceRuntime.mjs';

const ids=['sale-policy-local','sale-ledger-local','sale-binding-local','sale-reconciliation-local','sale-desktop-state-local'];
const command=n=>({name:n,file:'node',args:['--import','tsx',`scripts/verify-${n}.ts`],timeoutSeconds:90});
const event=(release,extra={})=>({id:'2026-11-21T10:00:00.000Z#'+'a'.repeat(64),code:'SALE_AUTOMATION_FAILED',surface:'server',operation:'verify',component:'sale-automation',release,...extra});
function profile(repoPath='/source',release='a'.repeat(40)){
 return {id:'inventory_web',targetApp:'inventory_web',repoPath,implementationProvider:'codex',models:{codex:{model:'gpt-6.1-sol',reasoningEffort:'high'}},allowedPaths:['lib/global.ts'],verification:{required:true,commands:[command('global')]},staging:{mode:'local-next-isolated',framework:'nextjs',hostBundle:{sha256:'b'.repeat(64)},environmentId:'isolated',dataAdapter:{kind:'fixture'}},desktopCua:{directory:'/outside',sessionPath:'/outside/session.json',bundleSha256:'b'.repeat(64),allowedActions:['navigate','reload','screenshot']},systemErrorRepair:{enabled:true,schemaVersion:1,release,sourceManifestSha256:'c'.repeat(64),scopes:Object.fromEntries(ids.map((id,i)=>[id,{allowedPaths:[`lib/saleCandidates/scope${i}.ts`,`scripts/verify-scope${i}.ts`],verification:{required:true,commands:[command(`scope${i}`)]}}]))}};
}
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sale-router-'));
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git(['init','-q']);git(['config','user.name','test']);git(['config','user.email','test@example.com']);git(['commit','--allow-empty','-qm','fixture']);
 const p=profile(root,git(['rev-parse','HEAD']));
 const store=await Store.open(':memory:'),repo=new Repo(store);installEcoSchema(store);repo.setPaused(false);
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 const calls=[],built=[];
 const phases=['qaInitial','specification','implementation','testing','staging','qaVerify'];
 function build(selected){
  const label=selected===p?'base':selected.allowedPaths.join(',');
  return {capabilities:()=>({implementationProvider:'codex',codex:{connected:true},staging:{connected:true,mode:'local-next-isolated'}}),
   adapters:Object.fromEntries(phases.map(phase=>[phase,Object.fromEntries(['execute','reconcile'].map(method=>[method,context=>{calls.push({label,phase,method,run:context.run.id});return {label};}]))])),
   prepareTask:task=>{calls.push({label,phase:'prepare'});return repo.updateTask(task.id,{base_commit:p.systemErrorRepair.release});},
   safetyGate:async()=>({allowed:true,label}),stopRun:()=>{},stop:()=>{}};
 }
 const base=build(p),bindings=withSystemErrorRouting({base,profile:p,repo,buildBindings:(selected,infrastructure)=>{assert.equal(infrastructure,p);built.push(selected);return build(selected);}});
 const settings=()=>({version:1,config:{enabled:true,mode:'cooperative_eco',stagingMode:'local-next-isolated'},capabilities:{implementationProvider:'codex'}});
 let sequence=0;
 const submit=(input=event(p.systemErrorRepair.release),start)=>registerSystemErrorRepair({input,repo,config:{execution:{provider:'codex'}},resolveContract:bindings.resolveSystemErrorRepair,settings,startHeldRun:start??(args=>{
   const id='eco_'+String(++sequence).padStart(32,'0');const task=repo.getTask(args.taskId);bindings.prepareTask(task,args);
   store.run('INSERT INTO eco_runs(id,task_id,version,state,data) VALUES(?,?,1,?,?)',[id,args.taskId,'WAITING_CAPACITY',JSON.stringify({revision:args.revision})]);return {id};
 })});
 return {p,repo,store,bindings,base,built,calls,submit,git,phases};
}
test('host catalog routes only exact server code/component/operation and approved release',()=>{
 const p=profile(),c=validateRepairCatalog(p);
 const cases=[['SALE_AUTOMATION_FAILED','sale-automation','identify',ids[0]],['SALE_AUTOMATION_FAILED','sale-automation','sell',ids[1]],['SALE_LINK_FAILED','sale-automation','adjust',ids[2]],['SALE_EC_UNCONFIRMED','sale-automation','verify',ids[3]],['SALE_DESKTOP_FAILED','sale-desktop','adjust',ids[4]]];
 for(const [code,component,operation,id]of cases){const r=resolveRepairRoute(event(c.release,{code,component,operation}),p,c);assert.equal(r.binding.scopeId,id);assert.deepEqual(r.binding.allowedPaths,p.systemErrorRepair.scopes[id].allowedPaths);assert.equal(r.contract.nativeCuaRequired,true);assert.equal(r.contract.requiresFrozenBundleReview,true);}
 for(const extra of [{component:'sale-desktop'},{surface:'web'},{code:'SALE_REMOTE_FORMAT_CHANGED'},{code:'SALE_IMPORT_FAILED',component:'sale-import'},{operation:'request'}])assert.equal(resolveRepairRoute(event(c.release,extra),p,c).reason,'UNSUPPORTED_DIAGNOSTIC');
 assert.equal(resolveRepairRoute(event('unknown'),p,c).reason,'RELEASE_NOT_APPROVED');
 for(const code of ['SALE_AUTH_REQUIRED','SALE_RATE_LIMITED'])assert.equal(resolveRepairRoute(event(c.release,{code}),p,c).reason,'OPERATIONAL_ATTENTION');
});
test('catalog rejects fallback hosts, protected paths, scripts/eval injection and weakened tests',()=>{
 for(const mutate of [p=>p.staging.mode='local-reviewed-http-fixture',p=>delete p.desktopCua,p=>p.targetApp='ec',p=>p.implementationProvider='claude',p=>p.systemErrorRepair.scopes[ids[0]].allowedPaths=['lib/auth.ts'],p=>p.systemErrorRepair.scopes[ids[0]].allowedPaths=['lib/saleCandidates/'],p=>p.systemErrorRepair.scopes[ids[0]].allowedPaths=['lib/a.ts','lib/A.ts'],p=>p.systemErrorRepair.scopes[ids[0]].verification.required=false,p=>p.systemErrorRepair.scopes[ids[0]].verification.commands[0].args=['-e','evil()'],p=>p.systemErrorRepair.scopes[ids[0]].verification.commands[0].file='powershell',p=>p.systemErrorRepair.scopes[ids[0]].verification.commands[0].args=['scripts/../evil.ts']]){
  const p=profile();mutate(p);assert.throws(()=>validateRepairCatalog(p));
 }
});
test('no approved catalog or unavailable host holds before task/worktree/provider dispatch',async t=>{
 const f=await fixture(t);delete f.p.systemErrorRepair;
 const no=withSystemErrorRouting({base:f.base,profile:f.p,repo:f.repo,buildBindings:()=>assert.fail()});
 assert.equal(no.resolveSystemErrorRepair(event('a'.repeat(40))).reason,'REPAIR_HOST_PROFILE_REQUIRED');
 const missing=withSystemErrorRouting({base:{...f.base,capabilities:()=>({})},profile:profile(f.p.repoPath,f.git(['rev-parse','HEAD'])),repo:f.repo,buildBindings:()=>assert.fail()});
 assert.equal(missing.resolveSystemErrorRepair(event(f.git(['rev-parse','HEAD']))).reason,'REPAIR_HOST_PROFILE_REQUIRED');
 const held=f.submit(event('unknown'));assert.equal(held.status,'held');assert.equal(f.repo.listTasks().length,0);assert.equal(f.calls.length,0);
});
test('saved scope drives every phase execute/reconcile and safety, never global union',async t=>{
 const f=await fixture(t),r=f.submit(),saved=readRepairRoute(f.repo,r.taskId),run={id:r.runId,task_id:r.taskId,revision:'system-error-v2:'+saved.binding.digest};
 assert.equal(f.repo.getTask(r.taskId).state,'paused');assert.equal(f.repo.claimNextTask('legacy'),null);
 for(const phase of f.phases)for(const method of ['execute','reconcile'])f.bindings.adapters[phase][method]({run});
 assert.equal((await f.bindings.safetyGate({run})).allowed,true);
 assert.equal(f.built.length,1);assert.deepEqual(f.built[0].allowedPaths,f.p.systemErrorRepair.scopes[ids[0]].allowedPaths);assert.deepEqual(f.built[0].verification,f.p.systemErrorRepair.scopes[ids[0]].verification);assert.equal(f.built[0].targetApp,'inventory_web');assert.equal(f.built[0].systemErrorRepair,undefined);assert.equal(f.calls.some(c=>c.label==='base'),false);
 assert.match(f.repo.getTask(r.taskId).instruction,/never replay an uncertain external write/);
});
test('lost acknowledgement replay is observation only after release advances',async t=>{
 const f=await fixture(t),input=event(f.p.systemErrorRepair.release),r=f.submit(input),n=f.calls.length;
 f.git(['commit','--allow-empty','-qm','advance']);
 assert.deepEqual(f.submit(input),{...r,existing:true});assert.equal(f.calls.length,n);assert.equal(f.repo.listTasks().length,1);
 assert.throws(()=>f.submit({...input,operation:'adjust'}),/EVENT_BINDING_CHANGED/);
 const next=f.submit({...input,id:input.id.replace(/a/g,'b')});assert.equal(next.status,'held');assert.equal(next.reason,'RELEASE_SOURCE_CHANGED');
});
test('crash before run leaves atomic paused route; scope drift prevents resumption',async t=>{
 const f=await fixture(t);assert.throws(()=>f.submit(undefined,()=>{throw Error('crash');}),/crash/);
 const task=f.repo.listTasks()[0];assert.equal(task.state,'paused');assert.ok(readRepairRoute(f.repo,task.id));
 const changed=structuredClone(f.p);changed.systemErrorRepair.scopes[ids[0]].allowedPaths.push('lib/other.ts');
 const b=withSystemErrorRouting({base:f.base,profile:changed,repo:f.repo,buildBindings:()=>assert.fail()});
 assert.throws(()=>b.prepareTask(task,{}),/BINDING_CHANGED/);assert.equal(f.calls.length,0);
 const r=f.submit();assert.equal(r.taskId,task.id);assert.equal(f.repo.listTasks().length,1);
});
test('fresh approved bundle/session envelope can change, fixed host scope cannot drift',async t=>{
 const f=await fixture(t),r=f.submit(),task=f.repo.getTask(r.taskId),saved=readRepairRoute(f.repo,task.id),run={id:r.runId,task_id:task.id,revision:'system-error-v2:'+saved.binding.digest};
 const fresh=structuredClone(f.p);fresh.staging.hostBundle.sha256='d'.repeat(64);fresh.desktopCua.bundleSha256='d'.repeat(64);fresh.staging.hostApproval={new:'review'};
 let built=0;const b=withSystemErrorRouting({base:f.base,profile:fresh,repo:f.repo,buildBindings:()=>{built++;return f.base;}});assert.equal((await b.safetyGate({run})).allowed,true);assert.equal(built,1);
 for(const mutate of [p=>p.models.codex.model='other',p=>p.desktopCua.allowedActions.push('click'),p=>p.staging.dataAdapter.kind='live',p=>p.qaSteps={sequence:['changed']},p=>p.systemErrorRepair.scopes[ids[0]].verification.commands[0].timeoutSeconds++]){
  const drift=structuredClone(fresh);mutate(drift);const b=withSystemErrorRouting({base:f.base,profile:drift,repo:f.repo,buildBindings:()=>assert.fail()});assert.equal((await b.safetyGate({run})).allowed,false);
 }
});
test('checkpoint tampering and mismatched run revision stop before any phase',async t=>{
 const f=await fixture(t),r=f.submit(),saved=readRepairRoute(f.repo,r.taskId),run={task_id:r.taskId,revision:'system-error-v1'};
 assert.throws(()=>f.bindings.adapters.testing.execute({run}),/RUN_BINDING_CHANGED/);
 const corrupt={...saved,binding:{...saved.binding,allowedPaths:['lib/other.ts']}};f.repo.checkpoint(r.taskId,'system_error_route',corrupt);
 assert.throws(()=>readRepairRoute(f.repo,r.taskId),/BINDING_INVALID/);
 assert.equal((await f.bindings.safetyGate({run})).allowed,false);
});
test('revoked scope and revision keep execution blocked while owned cleanup reaches infrastructure',async t=>{
 const f=await fixture(t),r=f.submit(),saved=readRepairRoute(f.repo,r.taskId),run={id:r.runId,task_id:r.taskId,revision:'system-error-v2:'+saved.binding.digest};
 const stopped=[];f.base.stopRun=value=>{stopped.push(value);return 'owned-stop';};
 const drift=structuredClone(f.p);drift.systemErrorRepair.scopes[ids[0]].allowedPaths.push('lib/other.ts');
 const b=withSystemErrorRouting({base:f.base,profile:drift,repo:f.repo,buildBindings:()=>assert.fail()});
 assert.throws(()=>b.adapters.testing.execute({run}),/BINDING_CHANGED/);assert.throws(()=>b.adapters.testing.reconcile({run}),/BINDING_CHANGED/);
 assert.equal(b.stopRun(run),'owned-stop');assert.deepEqual(stopped,[run]);
 const changed={...run,revision:'revoked-revision'};assert.throws(()=>b.adapters.testing.execute({run:changed}),/RUN_BINDING_CHANGED/);assert.equal(b.stopRun(changed),'owned-stop');assert.equal(stopped.length,2);
});
test('one active and three daily repair budgets are durable; held errors do not consume budget',async t=>{
 const f=await fixture(t);const input=event(f.p.systemErrorRepair.release);f.submit(input);
 const next=n=>({...input,id:input.id.replace(/a{64}$/,String(n).repeat(64))});
 assert.throws(()=>f.submit(next(1)),/already active/);
 for(let n=1;n<=2;n++){const last=f.repo.listTasks().find(x=>x.state==='paused');f.repo.setState(last.id,'cancelled','fixture','system',{});f.submit(next(n));}
 const last=f.repo.listTasks().find(x=>x.state==='paused');f.repo.setState(last.id,'cancelled','fixture','system',{});assert.throws(()=>f.submit(next(3)),/Daily automatic repair limit/);assert.equal(f.repo.listTasks().length,3);
});
test('bridge converts typed unsupported hold to operational attention without false dispatch',async()=>{
 const input=event('a'.repeat(40),{code:'SALE_REMOTE_FORMAT_CHANGED'}),acks=[];
 const b=new SystemErrorBridge({queue:{list:async()=>({events:[{...input,state:'PENDING'}]}),claim:async()=>({event:input,lease:'lease'}),acknowledge:async(...args)=>acks.push(args)},request:async()=>({status:'held',reason:'UNSUPPORTED_DIAGNOSTIC'})});
 const result=await b.once();assert.equal(result.dispatched,0);assert.equal(result.needsOperator,1);assert.equal(acks[0][2],'NEEDS_OPERATOR');assert.equal(acks[0][3],undefined);
});
test('canonical digest is stable across property order, not scope/test changes',()=>{assert.equal(repairDigest({b:2,a:1}),repairDigest({a:1,b:2}));assert.notEqual(repairDigest({allowedPaths:['a','b']}),repairDigest({allowedPaths:['b','a']}));});

test('real service factory scopes worktree binding, verifier plan and specification schema independently',async t=>{
 const f=await fixture(t),h=await buildHarness({repoPath:f.p.repoPath,execution:{provider:'codex'}});t.after(()=>h.cleanup());installEcoSchema(h.store);
 const root=path.dirname(h.paths.dataRoot),outside=fs.mkdtempSync(path.join(os.tmpdir(),'router-cua-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
 const p=structuredClone(f.p),s={...p.staging,service:'inventory_web',enabled:true,isolatedDataConfirmed:true,hostname:'127.0.0.1',port:49197,dataRoot:h.paths.dataRoot,hostAdapterPath:path.join(outside,'host.cjs'),hostAdapterSha256:'e'.repeat(64),dataAdapter:{kind:'fixture',id:'test'},executionPolicyId:'test',environmentId:'test',dataScopeId:'test',operationalDataRoots:[path.join(root,'operational')],operationalPorts:[49198],operationalDataScopeIds:['operational'],qaUrl:'http://127.0.0.1:49197/',revisionPath:'/api/revision'};
 s.hostBundle.descriptorPath=path.join(outside,'bundle.json');p.desktopCua={driver:'desktop-cua',frozenReviewedFixture:true,bundleSha256:s.hostBundle.sha256,cspSha256:CUA_CSP_SHA256,allowedActions:[...CUA_ACTIONS],directory:outside,sessionPath:path.join(outside,'session.json')};s.desktopCua=p.desktopCua;s.hostApproval={approved:true,approvalId:'fixture',...structuredClone(s)};p.staging=s;p.qaUrl=s.qaUrl;p.allowedDomains=['127.0.0.1'];p.qaSteps={sequence:[{type:'navigate'},{type:'reload'},{type:'screenshot'}],maxTotalSeconds:30};
 const raw={schemaVersion:1,profiles:{inventory_web:p}},validated=validateRuntimeConfig(raw,h.config);fs.writeFileSync(path.join(h.paths.dataRoot,'eco-runtime.json'),JSON.stringify(raw));
 const at=Date.now();fs.writeFileSync(path.join(h.paths.stateDir,'eco-probes.json'),JSON.stringify({profileHash:hash(validated),codex:{at,ok:true,account:'chatgpt'},staging:{at,ok:true}}));
 const builds=[],cli=[];
 const b=createServiceBindings({config:h.config,paths:h.paths,repo:h.repo,logger:h.logger,resolveCodex:()=> 'fake-codex',buildDelivery:options=>{builds.push(options.config.verification);return {revisionContract:true,available:()=>true,stop:()=>{}};},execute:async args=>{if(args.args[0]==='login')return {ok:true,stdout:'Logged in using ChatGPT',stderr:''};cli.push(args);return {ok:false,reason:'synthetic-cli-stop',stdout:'',stderr:'Usage limit reached'};}});
 const input=event(p.systemErrorRepair.release),selection=b.resolveSystemErrorRepair(input);assert.equal(selection.status,'ready');
 const operatorToken='test-operator-token-12345678901234567890',runtime=createEcoRuntime({store:h.store,repo:h.repo,config:h.config,paths:h.paths,logger:h.logger,bindings:b,operatorToken});
 const settings=runtime.repo.settings();runtime.repo.save({...settings.config,enabled:true,mode:'cooperative_eco',gptBrowserQa:false,qaUrl:p.qaUrl,allowedDomains:p.allowedDomains,stagingMode:'local-next-isolated'},settings.version,'synthetic-profile');h.repo.setPaused(false);
 const acks=[],bridge=new SystemErrorBridge({queue:{list:async()=>({events:[{...input,state:'PENDING'}]}),claim:async()=>({event:input,lease:'synthetic-lease'}),acknowledge:async(...args)=>acks.push(args)},request:async(method,route,body)=>runtime.api.handle(method,route,body,operatorToken)});
 assert.equal((await bridge.once()).dispatched,1);const registered={taskId:acks[0][3],runId:acks[0][4],existing:false},task=h.repo.getTask(registered.taskId);assert.equal(acks[0][2],'DISPATCHED');
 for(let i=0;i<8&&cli.length===0;i++)await runtime.tick();
 const run=runtime.repo.get(registered.runId);assert.equal(run.state,'WAITING_CAPACITY');assert.equal(run.configSnapshot.productionApproval,true);assert.equal(task.state,'paused');assert.equal(h.repo.claimNextTask('legacy'),null);
 assert.equal(builds.length,2);assert.deepEqual(builds[1],p.systemErrorRepair.scopes[ids[0]].verification);
 const checkpoint=JSON.parse(h.store.get("SELECT data FROM checkpoints WHERE task_id=? AND phase='eco_profile'",[task.id]).data);assert.deepEqual(checkpoint.allowedPaths,selection.binding.allowedPaths);
 assert.equal(cli.length,1);assert.deepEqual(runtime.api.handle('POST','/api/eco/system-error',input,operatorToken),{...registered,existing:true});await runtime.tick();assert.equal(cli.length,1);
 const schema=JSON.parse(fs.readFileSync(cli[0].args[cli[0].args.indexOf('--output-schema')+1],'utf8'));assert.deepEqual(schema.properties.scope.items.enum,selection.binding.allowedPaths);assert.equal(cli[0].input.includes('lib/global.ts'),false);
 const isolated=h.repo.getTask(task.id);fs.mkdirSync(path.join(isolated.work_dir,'lib'),{recursive:true});fs.writeFileSync(path.join(isolated.work_dir,'lib','global.ts'),'out of scope');
 assert.equal((await b.safetyGate({run})).allowed,false);
 await runtime.stop();
});

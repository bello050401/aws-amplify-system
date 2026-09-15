import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildHarness, initRepo } from './helpers.mjs';
import { makeReport } from '../src/runner/fakeRunner.mjs';
import { runProcess, localEnvironment } from '../src/pipeline/process.mjs';
import { IndependentVerifier } from '../src/pipeline/verification.mjs';
import { CodexRunner, ImplementationRouter, codexReportSchema } from '../src/runner/codexRunner.mjs';
import { StagingDelivery, AmplifyStaging, stagingPolicy } from '../src/pipeline/staging.mjs';
import { Notifications } from '../src/pipeline/notifications.mjs';
import { STATES } from '../src/core/states.mjs';
import { runGit, pushVerifiedStaging } from '../src/core/git.mjs';

const command = code => ({name:'independent test',file:'node',args:['-e',code],cwd:'.',timeoutSeconds:2});
const staging = {enabled:true,accountId:'123456789012',appId:'dexample',branch:'staging',repository:'https://github.com/example/repo.git',region:'ap-northeast-1',profile:'test',isolatedDataConfirmed:true,maxWaitSeconds:1800};
async function harness(overrides={}) {
  const h=await buildHarness(overrides); initRepo(h.config.repoPath);
  h.task=h.repo.createTask({title:'pipeline task',instruction:'implement',source:'system',repoPath:h.config.repoPath}).task;
  return h;
}

test('process: actual exit code, timeout, output limit and credential filtering', async () => {
  assert.deepEqual(localEnvironment({PATH:'safe',AWS_SECRET_ACCESS_KEY:'no',OPENAI_API_KEY:'no',BELLO_NOTIFICATION_TOKEN:'no'}),{PATH:'safe'});
  assert.equal((await runProcess({file:'node',args:['-e','process.exit(7)']})).exitCode,7);
  assert.equal((await runProcess({file:'node',args:['-e','setInterval(()=>{},1000)'],timeoutMs:100})).reason,'timeout');
  assert.equal((await runProcess({file:'node',args:['-e','process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'],maxBytes:100})).reason,'output_limit');
});

test('independent verifier rejects failure despite agent success; receipt is persisted and invalidated by edits', async () => {
  const h=await harness({verification:{required:true,commands:[command('process.exit(1)')]}});
  try {
    const task={...h.task,work_dir:h.config.repoPath,attempts:1};
    const verifier=new IndependentVerifier({config:h.config,paths:h.paths,repo:h.repo});
    assert.equal((await verifier.run(task)).passed,false);
    assert.equal(verifier.check(task).passed,false);
    verifier.settings.commands=[command('process.exit(0)')];
    assert.equal((await verifier.run(task)).passed,true);
    const restored=new IndependentVerifier({config:{verification:verifier.settings},paths:h.paths,repo:h.repo});
    assert.equal(restored.check(task).passed,true);
    assert.equal(restored.check({...task,attempts:2}).passed,false);
    fs.writeFileSync(path.join(task.work_dir,'README.md'),'changed after test');
    assert.equal(restored.check(task).passed,false);
  } finally {h.cleanup();}
});

test('independent verifier rejects source changes caused by a test and empty plans', async () => {
  const h=await harness({verification:{required:true,commands:[command('require("fs").writeFileSync("README.md","mutated")')]}});
  try {
    const v=new IndependentVerifier({config:h.config,paths:h.paths,repo:h.repo});
    assert.equal((await v.run({...h.task,work_dir:h.config.repoPath})).passed,false);
    v.settings.commands=[];
    assert.equal((await v.run({...h.task,work_dir:h.config.repoPath})).passed,false);
  } finally {h.cleanup();}
});

test('orchestrator: self-reported pass cannot override failed independent tests', async () => {
  const h=await harness({verification:{required:true,commands:[command('process.exit(2)')]}});
  try {
    h.runner.setDefault({ kind: 'success', report: makeReport(h.task.id, { changes: [{ path: 'README.md', purpose: 'existing file inspected' }], git: { branch: 'work', commitCreated: false } }) });
    await h.orchestrator.tick();
    assert.notEqual(h.repo.getTask(h.task.id).state,STATES.COMPLETED);
    assert.ok(h.repo.store.get("SELECT data FROM checkpoints WHERE task_id=? AND phase='independent_verification'",[h.task.id]));
  } finally {h.cleanup();}
});

test('Codex runner passes stdin/schema/worktree sandbox, validates report and task identity', async () => {
  const h=await harness();
  try {
    let seen;
    const task={...h.task,work_dir:h.config.repoPath,isolation:'worktree'};
    const execute=async options=>{
      seen=options;
      const report=makeReport(task.id);
      fs.writeFileSync(options.args[options.args.indexOf('--output-last-message')+1],JSON.stringify(report));
      return {ok:true,exitCode:0,stdout:'',stderr:''};
    };
    const runner=new CodexRunner({config:{codex:{}},paths:h.paths,logger:h.logger,execute});
    assert.equal((await runner.run({task,instruction:'do task'})).ok,true);
    assert.equal(seen.args.at(-1),'-');
    assert.ok(seen.input.includes('do task'));
    assert.ok(seen.args.includes('workspace-write'));
    assert.ok(seen.args.includes('sandbox_workspace_write.network_access=false'));
    assert.ok(!seen.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!('AWS_SECRET_ACCESS_KEY' in seen.env));
    assert.equal((await runner.run({task:{...task,isolation:'in-place'},instruction:'x'})).ok,false);
    const schema=codexReportSchema();
    assert.equal(schema.required.length,Object.keys(schema.properties).length);
    assert.equal(schema.properties.commandsRun.anyOf[1].type,'null');
    runner.execute=async opts=>{await execute(opts); const file=opts.args[opts.args.indexOf('--output-last-message')+1]; const report=JSON.parse(fs.readFileSync(file));report.taskId='wrong';fs.writeFileSync(file,JSON.stringify(report));return {ok:true,exitCode:0};};
    assert.equal((await runner.run({task,instruction:'x'})).ok,false);
  } finally {h.cleanup();}
});

test('implementation provider selection persists and routes only the next run',async()=>{
  const h=await harness();
  try {
    const router=new ImplementationRouter({repo:h.repo,config:{execution:{provider:'claude'}},runners:{claude:{run:async()=> 'claude'},codex:{run:async()=> 'codex'}}});
    assert.equal(await router.run({task:h.task}),'claude');
    h.repo.store.setMeta('implementationProvider','codex');
    assert.equal(await router.run({task:h.task}),'codex');
  } finally {h.cleanup();}
});

test('staging policy denies production, unknown data boundary and infrastructure changes',()=>{
  const task={isolation:'worktree',git_end_commit:'a'.repeat(40)};
  assert.equal(stagingPolicy(staging,task,['app/page.tsx']),null);
  for(const settings of [{...staging,branch:'production'},{...staging,isolatedDataConfirmed:false},{...staging,enabled:false}]) assert.ok(stagingPolicy(settings,task,['app/page.tsx']));
  for(const file of ['amplify/data/resource.ts','scripts/aws-setup/fix.ps1','db/migrations/001.sql','amplify.yml']) assert.ok(stagingPolicy(staging,task,[file]));
  assert.equal(pushVerifiedStaging({branch:'production'}).ok,false);
});

function mockGit(sha) {
  return (_cwd,args)=>args[0]==='show' ? {ok:false,stdout:''} : {ok:true,stdout:args[0]==='ls-remote'?`${sha}\trefs/heads/staging`:args[0]==='diff'?'app/page.tsx':'',stdoutRaw:''};
}
async function stagingHarness(adapter) {
  const h=await harness();
  const sha=runGit(h.config.repoPath,['rev-parse','HEAD']).stdout;
  h.task={...h.task,work_dir:h.config.repoPath,isolation:'worktree',git_end_commit:sha,base_commit:sha};
  h.delivery=new StagingDelivery({config:{staging},repo:h.repo,verifier:{required:true,check:()=>({passed:true})},git:mockGit(sha),adapterFactory:()=>adapter,publish:()=>{throw new Error('unexpected publish')}});
  return h;
}

test('staging persists job id and resumes polling without another release',async()=>{
  let starts=0;
  const adapter={preflight:async()=>{},start:async()=>{starts++;return '17'},poll:async()=>({status:'SUCCEED',commitId:h.task.git_end_commit})};
  const h=await stagingHarness(adapter);
  try {
    assert.equal(h.delivery.prepare(h.task).state,'ready');
    assert.equal((await h.delivery.advance(h.task)).state,'running');
    const restored=new StagingDelivery({config:{staging},repo:h.repo,verifier:{required:true,check:()=>({passed:true})},git:mockGit(h.task.git_end_commit),adapterFactory:()=>adapter});
    assert.equal((await restored.advance(h.task)).state,'succeeded');
    assert.equal(starts,1);
  } finally {h.cleanup();}
});

test('staging ambiguous dispatch is blocked and never automatically dispatched twice',async()=>{
  let starts=0;
  const h=await stagingHarness({preflight:async()=>{},start:async()=>{starts++;throw new Error('lost response')}});
  try {
    h.delivery.prepare(h.task);
    assert.equal((await h.delivery.advance(h.task)).state,'blocked');
    assert.equal((await h.delivery.advance(h.task)).state,'blocked');
    assert.equal(starts,1);
  } finally {h.cleanup();}
});

test('staging refuses wrong commit on successful cloud job',async()=>{
  const h=await stagingHarness({preflight:async()=>{},start:async()=> '18',poll:async()=>({status:'SUCCEED',commitId:'b'.repeat(40)})});
  try {h.delivery.prepare(h.task);await h.delivery.advance(h.task);assert.equal((await h.delivery.advance(h.task)).state,'blocked');} finally {h.cleanup();}
});

test('Amplify target validation rejects PRODUCTION and auto builds without start-job',async()=>{
  const calls=[];
  const adapter=new AmplifyStaging({settings:staging,execute:async({args})=>{calls.push(args[1]);return{ok:true,stdout:JSON.stringify(args[1]==='get-app'?{app:{appArn:`arn:aws:amplify:ap-northeast-1:${staging.accountId}:apps/${staging.appId}`,repository:staging.repository}}:{branch:{branchName:'staging',stage:'PRODUCTION',enableAutoBuild:true}})}}});
  await assert.rejects(()=>adapter.preflight());
  assert.deepEqual(calls,['get-app','get-branch']);
});

test('notification outbox survives restarts, retries with same id and never resends sent event',async()=>{
  const h=await harness();let requests=[];let success=false;
  const config={notifications:{enabled:true,webhookUrlEnvVar:'URL',tokenEnvVar:'TOKEN',maxAttempts:3,timeoutSeconds:1}};
  const options={config,repo:h.repo,env:{URL:'https://example.com/hook',TOKEN:'secret'},send:async(url,request)=>{requests.push(request);return{ok:success,status:success?200:503}}};
  try {
    const n=new Notifications(options);
    h.repo.setState(h.task.id,STATES.FAILED,'fixture failed','test');
    await n.tick();
    const row=h.repo.store.get('SELECT * FROM notification_outbox');
    assert.equal(row.status,'pending');
    h.repo.store.run('UPDATE notification_outbox SET next_at=?',[new Date(0).toISOString()]);
    success=true;
    const restarted=new Notifications(options);await restarted.tick();await restarted.tick();
    assert.equal(requests.length,2);
    assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);
    assert.equal(h.repo.store.get('SELECT status FROM notification_outbox').status,'sent');
    assert.ok(!row.event_json.includes('secret'));
  } finally {h.cleanup();}
});

test('disabled notifications capture future events without external transmission',async()=>{
  const h=await harness();
  try {
    const n=new Notifications({config:{notifications:{enabled:false}},repo:h.repo,send:()=>assert.fail('must not send')});
    h.repo.setState(h.task.id,STATES.FAILED,'fixture','test');await n.tick();
    assert.equal(h.repo.store.get('SELECT status FROM notification_outbox').status,'pending');
  } finally {h.cleanup();}
});

test('end-to-end: implementation, independent test, review, staging and persisted notification',async()=>{
  const h=await harness({verification:{required:true,commands:[command('process.exit(0)')]},staging});
  let starts=0,sends=0;
  try {
    const notices=new Notifications({config:{notifications:{enabled:true,webhookUrlEnvVar:'URL',tokenEnvVar:'TOKEN',maxAttempts:3,timeoutSeconds:1}},repo:h.repo,env:{URL:'https://example.com/hook'},send:async(_url,request)=>{sends++;assert.equal(JSON.parse(request.body).staging,'succeeded');return {ok:true,status:200}}});
    // The real orchestrator creates an isolated worktree. No source changes needed for this fixture.
    h.runner.setDefault({kind:'success',report:makeReport(h.task.id,{changes:[{path:'README.md',purpose:'inspected'}],git:{branch:'work',commitCreated:false}})});
    h.orchestrator.delivery=new StagingDelivery({config:h.config,repo:h.repo,verifier:h.orchestrator.verifier,git:(_cwd,args)=>mockGit(h.repo.getTask(h.task.id).git_end_commit)(_cwd,args),adapterFactory:()=>({preflight:async()=>{},start:async()=>{starts++;return '20'},poll:async()=>({status:'SUCCEED',commitId:h.repo.getTask(h.task.id).git_end_commit})})});
    await h.orchestrator.tick();
    assert.equal(h.repo.getTask(h.task.id).state,STATES.DELIVERING);
    await notices.tick();assert.equal(sends,0,'not completed before deployment');
    await h.orchestrator.tick();assert.equal(starts,1);
    await h.orchestrator.tick();assert.equal(h.repo.getTask(h.task.id).state,STATES.COMPLETED);
    await notices.tick();await notices.tick();assert.equal(sends,1);
  } finally {h.cleanup();}
});

test('staging publishes only after validating target and stops on rejected fast-forward',async()=>{
  const h=await stagingHarness({preflight:async()=>{validated=true},start:async()=>assert.fail('must not release after push failure')});
  let validated=false,published=false;
  try {
    h.delivery.git=mockGit('c'.repeat(40));
    h.delivery.publish=()=>{assert.equal(validated,true);published=true;return {ok:false}};
    h.delivery.prepare(h.task);
    assert.equal((await h.delivery.advance(h.task)).state,'blocked');assert.equal(published,true);
  } finally {h.cleanup();}
});

test('staging refuses a persisted in-flight dispatch on restart',async()=>{
  const h=await stagingHarness({preflight:()=>assert.fail('must not redispatch')});
  try {h.delivery.prepare(h.task);h.repo.store.run("UPDATE staging_deliveries SET state='starting'");assert.equal((await h.delivery.advance(h.task)).state,'blocked');} finally {h.cleanup();}
});

test('manual acceptance cannot bypass a missing independent receipt',async()=>{
  const h=await harness({verification:{required:true,commands:[command('process.exit(0)')]}});
  try {
    for(const state of [STATES.PREFLIGHT,STATES.RUNNING,STATES.VERIFYING,STATES.AWAITING_AI_REVIEW]) h.repo.setState(h.task.id,state,'fixture','test');
    const report=makeReport(h.task.id,{changes:[],git:{branch:'work',commitCreated:false}});
    const reportId=h.repo.saveReport(h.task.id,1,report,true);h.repo.updateTask(h.task.id,{report_id:reportId});
    h.repo.checkpoint(h.task.id,'evidence_gate',{passed:true,failures:[]});
    const result=h.orchestrator.applyManualReview({id:'manual',waitingTaskIds:[h.task.id],completed_answer:'accept_and_continue'});
    assert.equal(result.decision,'revision_required');
    assert.notEqual(h.repo.getTask(h.task.id).state,STATES.COMPLETED);
  } finally {h.cleanup();}
});

test('staging polling retries a transient network error without another dispatch',async()=>{
  let starts=0,polls=0;
  const h=await stagingHarness({preflight:async()=>{},start:async()=>{starts++;return '21'},poll:async()=>{if(polls++===0)throw new Error('network');return {status:'SUCCEED',commitId:h.task.git_end_commit}}});
  try {h.delivery.prepare(h.task);await h.delivery.advance(h.task);assert.equal((await h.delivery.advance(h.task)).state,'running');assert.equal((await h.delivery.advance(h.task)).state,'succeeded');assert.equal(starts,1);} finally{h.cleanup();}
});

test('dashboard exposes provider selection and delivery status without credentials',async()=>{
  const {Dashboard}=await import('../src/dashboard/server.mjs');
  const h=await harness();
  const dashboard=new Dashboard({config:{...h.config,dashboard:{...h.config.dashboard,enabled:true,port:0}},paths:h.paths,repo:h.repo,logger:h.logger,orchestrator:h.orchestrator,todoManager:h.todoManager,intake:h.intake,diagnostics:{}});
  try {
    await dashboard.start();const url=`http://127.0.0.1:${dashboard.server.address().port}`;
    const selected=await fetch(url+'/api/settings/implementation-provider',{method:'POST',headers:{'Content-Type':'application/json','X-BELLO-Request':'1'},body:JSON.stringify({provider:'codex'})});
    assert.equal(selected.status,200);assert.equal(h.repo.store.getMeta('implementationProvider'),'codex');
    const settings=await (await fetch(url+'/api/settings')).json();assert.equal(settings.implementationProvider,'codex');assert.equal(settings.automation.staging,false);
    const detail=await (await fetch(url+'/api/tasks/'+h.task.id)).json();assert.equal(detail.staging,null);assert.equal(detail.verification,null);
    const rejected=await fetch(url+'/api/settings/implementation-provider',{method:'POST',headers:{'Content-Type':'application/json','X-BELLO-Request':'1'},body:JSON.stringify({provider:'other'})});assert.notEqual(rejected.status,200);
  } finally {await dashboard.stop();h.cleanup();}
});

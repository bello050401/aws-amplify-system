import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { buildHarness, initRepo } from './helpers.mjs';
import { runGit } from '../src/core/git.mjs';
import { createTaskWorktree } from '../src/core/worktree.mjs';
import { localEnvironment } from '../src/pipeline/process.mjs';
import { LocalNextDelivery, validateLocalNextSettings, assertIsolationProof, assertLocalNextSource, loadLocalNextHost } from '../src/pipeline/localNextStaging.mjs';
import { digest } from '../src/pipeline/staticStaging.mjs';
import { DEFAULT_ECO, validateEco } from '../src/eco/policy.mjs';
import { createServiceBindings, createStagingDelivery } from '../src/eco/serviceBindings.mjs';
import { createEcoRuntime } from '../src/eco/serviceRuntime.mjs';
import { installEcoSchema } from '../src/eco/store.mjs';
import { fingerprint } from '../src/pipeline/verification.mjs';

function settingsFor(root,port) {
  const s = { mode: 'local-next-isolated',framework: 'nextjs',service: 'inventory_web',enabled: true,isolatedDataConfirmed: true,
    hostname: '127.0.0.1',port,dataRoot: path.join(root,'isolated'),hostAdapterPath: path.join(root,'host.cjs'),hostAdapterSha256: 'a'.repeat(64),
    dataAdapter: { kind: 'fixture',id: 'inventory-fixture' },executionPolicyId: 'test-host-policy',environmentId: 'inventory-local-foundation',dataScopeId: 'test-fixture',
    operationalDataRoots: [path.join(root,'photo')],operationalPorts: [port === 4321 ? 4322 : 4321],operationalDataScopeIds: ['photo-operational'],
    qaUrl: `http://127.0.0.1:${port}/`,revisionPath: '/api/revision',maxWaitSeconds: 10 };
  s.hostApproval = { approved: true,approvalId: 'test-approval',...structuredClone(Object.fromEntries(['hostname','port','dataRoot','hostAdapterPath','hostAdapterSha256','executionPolicyId','environmentId','dataScopeId','qaUrl','revisionPath','dataAdapter','operationalDataRoots','operationalPorts','operationalDataScopeIds'].map(key => [key,s[key]]))) };
  return s;
}

// Mock enforcement evidence exercises the host boundary, not OS sandbox security.
// This small HTTP subprocess tests PID/port/revision/stop, not Next.js rendering.
function isolation(s) {
  return { executionPolicyId: s.executionPolicyId,enforcementId: 'test-only-host-boundary',dataRoot: s.dataRoot,hostname: s.hostname,port: s.port,
    network: { outbound: 'deny',loopback: `${s.hostname}:${s.port}`,evidenceId: 'test-network-evidence' },
    filesystem: { productionConfig: 'deny',operationalData: 'deny',evidenceId: 'test-filesystem-evidence' },
    credentials: { inheritance: 'deny',defaultAwsFiles: 'deny',metadata: 'deny',evidenceId: 'test-credentials-evidence' },
    runtime: { framework: 'nextjs',dataAdapterId: s.dataAdapter.id,dataAdapterKind: s.dataAdapter.kind } };
}

async function freePort() {
  const server = net.createServer();
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function fixture(t) {
  const h = await buildHarness(); t.after(() => h.cleanup()); initRepo(h.config.repoPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bello-local-next-'));
  t.after(() => fs.rmSync(root,{ recursive: true,force: true }));
  const settings = settingsFor(root,await freePort());
  fs.mkdirSync(settings.dataRoot); fs.mkdirSync(settings.operationalDataRoots[0]);
  for (const name of ['config.json','photo.db','queue.json']) fs.writeFileSync(path.join(settings.operationalDataRoots[0],name),'preserve-'+name);
  fs.mkdirSync(path.join(h.config.repoPath,'app'),{ recursive: true });
  fs.writeFileSync(path.join(h.config.repoPath,'package.json'),JSON.stringify({ dependencies: { next: '15.0.0' } }));
  fs.writeFileSync(path.join(h.config.repoPath,'app','page.js'),'export default function Page(){return <main>Fixture</main>}');
  execFileSync('git',['add','package.json','app/page.js'],{ cwd: h.config.repoPath });
  execFileSync('git',['commit','-qm','local next fixture'],{ cwd: h.config.repoPath });
  const task = h.repo.createTask({ title: 'local Next contract',instruction: 'test',repoPath: h.config.repoPath,workDir: h.config.repoPath }).task;
  Object.assign(task,{ isolation: 'worktree',work_dir: h.config.repoPath,git_end_commit: runGit(h.config.repoPath,['rev-parse','HEAD']).stdout.trim() });
  const verifier = { required: true,check: () => ({ passed: true,receipt: { passed: true,fingerprint: 'b'.repeat(64),plan: 'c'.repeat(64) } }) };
  let child = null, childExited, identity, processReceipt, wrongRevision = false, starts = 0, stops = 0;
  async function closeChild() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childExited;
  }
  const host = {
    preflight: async () => isolation(settings),
    runVerification: async () => ({ ok: true,exitCode: 0,stdout: '',stderr: '',isolation: isolation(settings) }),
    launchBrowser: async () => { throw Error('HTTP fixture does not claim browser evidence'); },
    async start({ source }) {
      starts++;
      identity = { revision: source.commit,deploymentId: 'local-test-' + starts,environmentId: settings.environmentId,dataScopeId: settings.dataScopeId,verificationFingerprint: source.fingerprint };
      const code = `const http=require('node:http');const value=JSON.parse(process.argv[1]);http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value))}).listen(Number(process.argv[2]),'127.0.0.1',()=>process.stdout.write('ready\\n'));`;
      child = spawn(process.execPath,['-e',code,JSON.stringify(identity),String(settings.port)],{ env: localEnvironment(),windowsHide: true,stdio: ['ignore','pipe','pipe'] });
      childExited = once(child,'exit');
      await Promise.race([once(child.stdout,'data'),childExited.then(() => { throw Error('HTTP fixture failed to start'); }),new Promise((_,reject) => { const timer = setTimeout(() => reject(Error('fixture startup timeout')),5000); timer.unref(); })]);
      processReceipt = { ...identity,pid: child.pid,port: settings.port,hostname: settings.hostname,instanceId: 'test-process-instance-' + starts,isolation: isolation(settings) };
      return processReceipt;
    },
    inspect: async () => ({ ...processReceipt,...(wrongRevision && { revision: 'e'.repeat(40) }),running: !!child && child.exitCode === null && !child.killed }),
    async stop() {
      stops++;
      await closeChild();
      let closed = false;
      try { await fetch(settings.qaUrl,{ signal: AbortSignal.timeout(1000) }); } catch { closed = true; }
      return { stopped: true,portClosed: closed };
    },
  };
  t.after(closeChild);
  const d = new LocalNextDelivery({ config: { repoPath: h.config.repoPath,staging: settings },repo: h.repo,verifier,host });
  return { h,root,settings,task,host,d,identity: () => identity,starts: () => starts,stops: () => stops,setWrongRevision: value => wrongRevision = value };
}

test('local configuration rejects shared ports/data, names-only isolation, unknown modes and cloud fallback', () => {
  const root = path.join(os.tmpdir(),'local-next-validation');
  validateLocalNextSettings(settingsFor(root,4567));
  for (const change of [s => s.mode = 'local-next',s => s.hostname = 'localhost',s => s.hostname = '0.0.0.0',s => s.port = 443,s => s.dataRoot = s.operationalDataRoots[0],s => s.operationalPorts.push(s.port),s => s.operationalDataScopeIds.push(s.dataScopeId),s => s.appId = 'd4hkkg7dty2du',s => delete s.hostApproval,s => delete s.executionPolicyId,s => delete s.hostAdapterSha256]) {
    const s = settingsFor(root,4567); change(s); assert.throws(() => validateLocalNextSettings(s));
  }
  const s = settingsFor(root,4567);
  assert.throws(() => assertIsolationProof({ isolated: true,NODE_ENV: 'test' },s));
  for (const [section,key] of [['network','outbound'],['filesystem','productionConfig'],['credentials','defaultAwsFiles'],['credentials','metadata'],['network','evidenceId']]) {
    const proof = isolation(s); delete proof[section][key]; assert.throws(() => assertIsolationProof(proof,s));
  }
  assert.throws(() => createStagingDelivery({ config: { staging: { mode: 'production' } } }));
});

test('loopback HTTP is allowed only for explicit mode and connected exact host target', () => {
  const qaUrl = 'http://127.0.0.1:4567/';
  const local = { stagingMode: 'local-next-isolated',qaUrl,allowedDomains: ['127.0.0.1'] };
  const capabilities = { staging: { connected: true,mode: 'local-next-isolated',qaUrl } };
  assert.doesNotThrow(() => validateEco(local,capabilities));
  assert.throws(() => validateEco({ ...local,stagingMode: '' },capabilities));
  assert.throws(() => validateEco(local,{}));
  assert.match(validateEco(local,{}, { checkConnectedTarget: false }).missing[0],/host-approved/);
  assert.throws(() => validateEco({ ...local,qaUrl: 'http://127.0.0.1:4568/' },capabilities));
  const filtered = localEnvironment({ PATH: 'path',AWS_ACCESS_KEY_ID: 'test-only',AWS_PROFILE: 'test-only',NODE_OPTIONS: '--require bad',HTTPS_PROXY: 'http://bad',BELLO_TOKEN: 'test-only' });
  assert.deepEqual(filtered,{ PATH: 'path' });
});

test('missing pinned host adapter is honestly unconnected and cannot start a process', async t => {
  const f = await fixture(t);
  const d = new LocalNextDelivery({ config: { repoPath: f.h.config.repoPath,staging: f.settings },repo: f.h.repo,verifier: f.d.verifier });
  await assert.rejects(d.preflight(),/adapter/);
  assert.equal(d.prepare(f.task).state,'blocked'); assert.equal(f.starts(),0);
});

test('pinned adapter must live outside repository and writable data, and have the complete contract', async t => {
  const f = await fixture(t);
  const contents = 'module.exports={}'; fs.writeFileSync(f.settings.hostAdapterPath,contents);
  f.settings.hostAdapterSha256 = f.settings.hostApproval.hostAdapterSha256 = digest(contents);
  assert.throws(() => loadLocalNextHost(f.settings,f.h.config.repoPath),/incomplete/);
  f.settings.hostAdapterPath = f.settings.hostApproval.hostAdapterPath = path.join(f.task.work_dir,'adapter.cjs');
  fs.writeFileSync(f.settings.hostAdapterPath,contents);
  assert.throws(() => loadLocalNextHost(f.settings,f.h.config.repoPath),/outside/);
});

test('local source guards forbidden config names before independent verifier reads source', async t => {
  const f = await fixture(t);
  for (const name of ['.env.production','amplify_outputs.json']) {
    const filename = path.join(f.task.work_dir,name);
    fs.writeFileSync(filename,'test fixture; no credentials');
    assert.throws(() => assertLocalNextSource(f.task),/sanitized/);
    assert.throws(() => f.d.source(f.task),/sanitized/);
    fs.unlinkSync(filename);
  }
  f.host.preflight = async () => ({ isolated: true });
  await assert.rejects(f.d.preflight(),/enforced/);
  let closed = false;
  f.host.launchBrowser = async () => ({ browser: { close: async () => { closed = true; } },isolation: { isolated: true } });
  await assert.rejects(f.d.launchBrowser(),/isolation/); assert.equal(closed,true);
});

test('host-only real HTTP subprocess ties revision to PID/port/fingerprint and confirms stop', async t => {
  const f = await fixture(t);
  assert.equal(f.d.prepare(f.task).state,'ready');
  assert.equal((await f.d.advance(f.task)).state,'running');
  assert.equal((await f.d.advance(f.task)).state,'succeeded');
  const saved = JSON.parse(f.d.row(f.task.id).config_json);
  assert.equal(saved.http.revision,f.task.git_end_commit); assert.equal(saved.http.pid,saved.process.pid);
  assert.equal(saved.http.port,f.settings.port); assert.equal(saved.http.verificationFingerprint,'b'.repeat(64));
  assert.equal((await f.d.verifyDeployed(f.task)).ok,true);
  f.setWrongRevision(true); assert.equal((await f.d.verifyDeployed(f.task)).ok,false);
  f.setWrongRevision(false);
  await f.d.stop(); assert.equal(f.d.row(f.task.id).state,'blocked');
  assert.equal((await f.d.verifyDeployed(f.task)).ok,false);
  assert.equal(f.starts(),1);
  for (const name of ['config.json','photo.db','queue.json']) assert.equal(fs.readFileSync(path.join(f.settings.operationalDataRoots[0],name),'utf8'),'preserve-'+name);
});

test('wrong HTTP revision and lost start response cannot pass or cause duplicate process launch', async t => {
  const f = await fixture(t);
  f.d.prepare(f.task); await f.d.advance(f.task);
  const realRequest = f.d.request;
  f.d.request = async () => Response.json({ ...f.identity(),revision: 'f'.repeat(40) });
  assert.equal((await f.d.advance(f.task)).state,'running');
  f.d.request = realRequest; assert.equal((await f.d.advance(f.task)).state,'succeeded');
  // Resume using the persisted PID receipt, without a new start call.
  const resumed = new LocalNextDelivery({ config: { repoPath: f.h.config.repoPath,staging: f.settings },repo: f.h.repo,verifier: f.d.verifier,host: f.host });
  assert.equal((await resumed.verifyDeployed(f.task)).ok,true); assert.equal(f.starts(),1);
  await resumed.stop();
  const g = await fixture(t);
  const start = g.host.start;
  g.host.start = async args => { await start(args); throw Error('lost response'); };
  const stop = g.host.stop;
  g.host.stop = async () => ({ stopped: false,portClosed: false });
  g.d.prepare(g.task); assert.equal((await g.d.advance(g.task)).state,'blocked');
  const recovered = new LocalNextDelivery({ config: { repoPath: g.h.config.repoPath,staging: g.settings },repo: g.h.repo,verifier: g.d.verifier,host: g.host });
  assert.equal(recovered.prepare(g.task).state,'blocked');
  assert.equal((await recovered.advance(g.task)).state,'blocked'); assert.equal(g.starts(),1);
  assert.match(JSON.parse(recovered.row(g.task.id).config_json).startAttemptId,/^[a-f0-9-]{36}$/);
  g.host.stop = stop;
  await g.d.stop();
});

for (const phase of ['preflight','start','inspect']) {
  test('cancellation during ' + phase + ' serializes cleanup without reviving staging', async t => {
    const f = await fixture(t);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const method = f.host[phase];
    f.host[phase] = async (...args) => {
      entered.resolve();
      await release.promise;
      return method.apply(f.host,args);
    };
    f.d.prepare(f.task);
    const advancing = f.d.advance(f.task);
    await entered.promise;
    const stopping = f.d.stopTask(f.task.id);
    assert.equal(f.d.stopTask(f.task.id),stopping);
    assert.equal(f.stops(),0);
    release.resolve();
    await Promise.all([advancing,stopping]);
    assert.equal((await f.d.advance(f.task)).state,'blocked');
    assert.equal(f.starts(),phase === 'preflight' ? 0 : 1);
    assert.equal(f.stops(),f.starts());
    assert.equal((await f.d.verifyDeployed(f.task)).ok,false);
    await assert.rejects(fetch(f.settings.qaUrl,{ signal: AbortSignal.timeout(1000) }));
  });
}

test('a new independently verified revision rotates only after stop and archives the old receipt', async t => {
  const f = await fixture(t);
  f.d.prepare(f.task);
  await f.d.advance(f.task);
  const previous = await f.d.advance(f.task);
  assert.equal(previous.state,'succeeded');
  const file = path.join(f.task.work_dir,'app','page.js');
  fs.appendFileSync(file,'\n// second verified revision\n');
  execFileSync('git',['commit','-qam','second fixture revision'],{ cwd: f.task.work_dir,windowsHide: true });
  f.task.git_end_commit = runGit(f.task.work_dir,['rev-parse','HEAD']).stdout.trim();
  const stop = f.host.stop;
  f.host.stop = async () => ({ stopped: false,portClosed: false });
  assert.equal((await f.d.prepareRevision(f.task)).state,'blocked');
  assert.equal(f.d.row(f.task.id).commit_id,previous.commit_id);
  f.host.stop = stop;
  assert.equal((await f.d.prepareRevision(f.task)).state,'ready');
  assert.equal(f.stops(),1);
  assert.equal(f.d.row(f.task.id).job_id,null);
  const stored = f.h.repo.store.get("SELECT data FROM checkpoints WHERE task_id=? AND phase='local_next_history'",[f.task.id]);
  const history = JSON.parse(stored.data);
  assert.equal(history.revision,previous.commit_id);
  assert.equal(history.deploymentId,previous.job_id);
  assert.equal(history.stopped,true);
  assert.equal(history.http.revision,previous.commit_id);
  await Promise.all([f.d.advance(f.task),f.d.advance(f.task)]);
  assert.equal((await f.d.advance(f.task)).state,'succeeded');
  assert.equal(f.starts(),2);
  assert.equal((await f.d.verifyDeployed(f.task)).identity.revision,f.task.git_end_commit);
});

test('managed dirty repair freezes the commit, waits for its exact reviewed pin, verifies, then rotates the occupied preview', async t => {
  const f = await fixture(t);
  const { h, host, task } = f;
  installEcoSchema(h.store);
  const created = createTaskWorktree({ repoPath: h.config.repoPath,worktreeRoot: h.paths.worktreeRoot,taskId: task.id,logger: h.logger });
  assert.equal(created.ok,true,created.reason);
  h.repo.updateTask(task.id,{ isolation: 'worktree',work_dir: created.path,base_commit: created.baseCommit });
  const events = [];
  const pins = new Map();
  function pin(staging, suffix, source) {
    const hostBundle = { descriptorPath: path.join(f.root,'bundle-' + suffix + '.json'),sha256: digest(suffix) };
    pins.set(hostBundle.sha256,source);
    return { ...staging,hostBundle,hostApproval: { ...staging.hostApproval,hostBundle } };
  }
  host.verifyBundle = ({ settings }) => ({ source: pins.get(settings.hostBundle.sha256) });
  host.runVerification = async ({ settings, source }) => {
    assert.deepEqual(source,pins.get(settings.hostBundle.sha256));
    events.push('verify ' + source.commit);
    return { ok: true,exitCode: 0,stdout: 'fixture verification',stderr: '',isolation: isolation(settings) };
  };
  host.preflight = async ({ settings, checkPort }) => {
    events.push('probe ' + checkPort);
    if (checkPort && f.starts() > f.stops()) throw Error('occupied port');
    return isolation(settings);
  };
  const stop = host.stop;
  host.stop = async ({ settings, ...args }) => {
    assert.deepEqual(settings.hostBundle, baseline.hostBundle);
    events.push('stop baseline');
    return stop.call(host,{ settings,...args });
  };
  const start = host.start;
  host.start = async args => {
    events.push('start ' + args.source.commit);
    return start.call(host,args);
  };
  const verification = { required: true,commands: [{ name: 'real',file: 'node',args: ['verify.cjs'],timeoutSeconds: 4 }] };
  const sourceA = { commit: created.baseCommit,fingerprint: fingerprint(created.path),plan: digest(JSON.stringify(verification)) };
  const baseline = pin(f.settings,'initial',sourceA);
  const profile = staging => ({
    targetApp: 'inventory_web',repoPath: h.config.repoPath,allowedPaths: ['app/page.js'],verification,
    models: { codex: { model: 'gpt-test' } },qaUrl: staging.qaUrl,allowedDomains: [staging.hostname],staging,
    playwright: { modulePath: path.resolve('package.json') },
    qaSteps: { sequence: [{ type: 'navigate' },{ type: 'reload' },{ type: 'screenshot' }],maxTotalSeconds: 10 },
  });
  let delivery;
  function bindingsFor(staging) {
    fs.writeFileSync(path.join(h.paths.dataRoot,'eco-runtime.json'),JSON.stringify({ schemaVersion: 1,profiles: { inventory_web: profile(staging) } }));
    return createServiceBindings({
      config: h.config,paths: h.paths,repo: h.repo,logger: h.logger,resolveCodex: () => null,
      buildDelivery: options => (delivery = new LocalNextDelivery({ ...options,host })),
    });
  }
  const bindingsA = bindingsFor(baseline);
  assert.equal((await bindingsA.adapters.test.execute({ run: { id: 'baseline',task_id: task.id,headSHA: sourceA.commit },operationKey: 'verified-baseline' })).status,'succeeded');
  const readyA = await delivery.prepareRevision(h.repo.getTask(task.id));
  assert.equal(readyA.state,'ready');
  await delivery.advance(h.repo.getTask(task.id));
  assert.equal((await delivery.advance(h.repo.getTask(task.id))).state,'succeeded');
  const token = 'local-operator-fixture';
  const runtimeFor = bindings => createEcoRuntime({
    store: h.store,repo: h.repo,config: h.config,paths: h.paths,logger: h.logger,operatorToken: token,
    bindings: { ...bindings,capabilities: () => ({ codex: { connected: true },browserQa: { connected: true },staging: { connected:true,mode: baseline.mode,qaUrl: baseline.qaUrl } }) },
  });
  const runtimeA = runtimeFor(bindingsA);
  const config = { ...DEFAULT_ECO,enabled: true,mode: 'cooperative_eco',stagingAutoDeploy: true,stagingMode: baseline.mode,qaUrl: baseline.qaUrl,allowedDomains: [baseline.hostname] };
  runtimeA.repo.save(config,0,'enable-local-bundle-review-0001');
  h.store.setMeta('paused','0');
  const run = runtimeA.repo.create(task.id,{ revision: 'fixture',acIds: ['AC1'] },'create-local-bundle-review-0001');
  // Begin at TESTING as if the implementation worker returned the base HEAD and dirty scoped edits.
  const saved = { ...JSON.parse(run.data),headSHA: sourceA.commit,repairCount: 1 };
  h.store.run("UPDATE eco_runs SET state='TESTING',data=? WHERE id=?",[JSON.stringify(saved),run.id]);
  fs.appendFileSync(path.join(created.path,'app','page.js'),'\n// managed dirty repair\n');
  assert.equal(await runtimeA.tick(),true);
  const pending = runtimeA.api.handle('GET','/api/eco/runs/' + run.id);
  assert.equal(pending.run.state,'WAITING_APPROVAL');
  assert.equal(pending.run.resumeState,'TESTING');
  assert.equal(pending.run.testRecord,undefined);
  assert.equal(pending.pendingLocalBundle.commit,runGit(created.path,['rev-parse','HEAD']).stdout);
  assert.notEqual(pending.pendingLocalBundle.commit,sourceA.commit);
  assert.equal(pending.pendingLocalBundle.plan,sourceA.plan);
  assert.equal(runGit(created.path,['status','--porcelain']).stdout,'');
  assert.deepEqual(events.filter(event => event.startsWith('verify')),['verify ' + sourceA.commit]);
  assert.equal(f.stops(),0);
  const updated = pin(baseline,'repair',pending.pendingLocalBundle);
  const runtimeB = runtimeFor(bindingsFor(updated));
  runtimeB.api.handle('POST','/api/eco/control',{
    runId: run.id,expectedVersion: pending.run.version,action: 'resume',idempotencyKey: 'resume-local-bundle-review-0001',
  },token);
  assert.equal(await runtimeB.tick(),true);
  assert.equal(runtimeB.getRun(run.id).run.state,'STAGING_DEPLOYING');
  assert.equal(runtimeB.getRun(run.id).run.testRecord.revision,pending.pendingLocalBundle.commit);
  assert.equal(await runtimeB.tick(),false);
  assert.equal(await runtimeB.tick(),true);
  assert.equal(runtimeB.getRun(run.id).run.state,'QA_VERIFY');
  assert.deepEqual(events.slice(-5),['verify ' + pending.pendingLocalBundle.commit,'probe false','stop baseline','probe true','start ' + pending.pendingLocalBundle.commit]);
  const history = h.store.get("SELECT data FROM checkpoints WHERE phase='local_next_history' AND task_id=?",[task.id]);
  assert.equal(JSON.parse(history.data).revision,sourceA.commit);
  assert.equal(f.starts(),2);
});

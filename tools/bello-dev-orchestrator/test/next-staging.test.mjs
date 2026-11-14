import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildHarness, initRepo } from './helpers.mjs';
import { runGit } from '../src/core/git.mjs';
import { NextStagingDelivery, NextAmplifyStaging, validateNextSettings, readRevision } from '../src/pipeline/nextStaging.mjs';
import { AmplifyStaticDelivery } from '../src/pipeline/staticStaging.mjs';
import { createStagingDelivery } from '../src/eco/serviceBindings.mjs';

export function nextSettings() {
  const s = { mode: 'real-staging', framework: 'nextjs', enabled: true, isolatedDataConfirmed: true, service: 'inventory_web', environment: 'dedicated-preview', stagingId: 'inventory-foundation',
    accountId: '123456789012', region: 'ap-northeast-1', appId: 'dnexttest', appName: 'inventory-foundation', branch: 'preview-inventory', profile: 'dedicated-test', repository: 'https://github.com/example/inventory',
    environmentId: 'inventory-foundation', dataScopeId: 'fixture-20261114', qaUrl: 'https://preview-inventory.dnexttest.amplifyapp.com/', revisionPath: '/api/revision', maxWaitSeconds: 60 };
  s.hostApproval = { approved: true, purpose: 'verification-only', approvalId: 'host-approval-test', ...Object.fromEntries(['service','accountId','region','appId','appName','branch','repository','environment','stagingId','environmentId','dataScopeId','qaUrl','profile','revisionPath'].map(key => [key,s[key]])),
    isolation: { dedicated: true, productionDataAccess: false, verifiedBy: 'host-test', evidenceId: 'resource-audit-test', resourceIds: ['fixture-resource'], operationalResourceIds: ['operational-resource'], operationalDataScopeIds: ['operational-data'] } };
  return s;
}

export async function nextFixture(t, settings = nextSettings()) {
  const h = await buildHarness();
  t.after(() => h.cleanup());
  initRepo(h.config.repoPath);
  const baseCommit = runGit(h.config.repoPath,['rev-parse','HEAD']).stdout.trim();
  fs.mkdirSync(path.join(h.config.repoPath,'app','api','revision'),{ recursive: true });
  fs.writeFileSync(path.join(h.config.repoPath,'package.json'),JSON.stringify({ private: true, dependencies: { next: '15.0.0', react: '19.0.0' }, scripts: { start: 'next start' } }));
  fs.writeFileSync(path.join(h.config.repoPath,'app','page.js'),'export default function Page(){return <main>Next fixture</main>}');
  fs.writeFileSync(path.join(h.config.repoPath,'app','api','revision','route.js'),'export async function GET(){return Response.json({})}');
  execFileSync('git',['add','package.json','app/page.js','app/api/revision/route.js'],{ cwd: h.config.repoPath });
  execFileSync('git',['commit','-qm','next fixture'],{ cwd: h.config.repoPath });
  const task = h.repo.createTask({ title: 'Next.js staging foundation', instruction: 'test only', repoPath: h.config.repoPath, workDir: h.config.repoPath }).task;
  Object.assign(task,{ work_dir: h.config.repoPath, isolation: 'worktree', base_commit: baseCommit, git_end_commit: runGit(h.config.repoPath,['rev-parse','HEAD']).stdout.trim() });
  const verification = { passed: true, receipt: { passed: true, fingerprint: 'b'.repeat(64), plan: 'c'.repeat(64) } };
  const verifier = { required: true, check: () => structuredClone(verification) };
  const git = (cwd,args) => args[0] === 'ls-remote' ? { ok: true, stdout: `${task.git_end_commit}\trefs/heads/${settings.branch}` } : runGit(cwd,args);
  const expected = (deploymentId = '71') => ({ revision: task.git_end_commit, deploymentId, environmentId: settings.environmentId, dataScopeId: settings.dataScopeId, verificationFingerprint: verification.receipt.fingerprint });
  return { h,task,settings,verifier,verification,git,expected };
}

export function cloudObjects(s) {
  return {
    app: { appArn: `arn:aws:amplify:${s.region}:${s.accountId}:apps/${s.appId}`, name: s.appName, repository: s.repository, platform: 'WEB_COMPUTE', enableBranchAutoBuild: false, environmentVariables: { BELLO_ENVIRONMENT_ID: s.environmentId, BELLO_DATA_SCOPE_ID: s.dataScopeId, BELLO_ISOLATION_EVIDENCE_ID: s.hostApproval.isolation.evidenceId } },
    branch: { branchName: s.branch, stage: 'DEVELOPMENT', framework: 'Next.js - SSR', enableAutoBuild: false },
  };
}

test('Next.js target requires exact host approval and resource evidence; names alone never isolate', () => {
  validateNextSettings(nextSettings());
  const alternatePort = nextSettings();
  alternatePort.qaUrl = alternatePort.hostApproval.qaUrl = alternatePort.qaUrl.replace('.com/', '.com:8443/');
  assert.throws(() => validateNextSettings(alternatePort), /exact dedicated/);
  for (const key of ['accountId','appId','branch','repository','environmentId','dataScopeId','qaUrl']) {
    const s = nextSettings(); s[key] += 'wrong'; assert.throws(() => validateNextSettings(s),key);
  }
  for (const change of [s => delete s.hostApproval, s => delete s.hostApproval.isolation.evidenceId,
    s => s.hostApproval.isolation.productionDataAccess = true,
    s => s.hostApproval.isolation.resourceIds = ['operational-resource'],
    s => s.hostApproval.isolation.operationalDataScopeIds.push(s.dataScopeId),
    s => { s.appId = s.hostApproval.appId = 'd4hkkg7dty2du'; }, s => s.framework = 'static']) {
    const s = nextSettings(); change(s); assert.throws(() => validateNextSettings(s));
  }
});

test('real staging is never routed to static HTML; unknown and production modes fail closed', async () => {
  assert.ok(createStagingDelivery({ config: { staging: nextSettings() } }) instanceof NextStagingDelivery);
  for (const mode of ['production','unknown',undefined]) assert.throws(() => createStagingDelivery({ config: { staging: { mode } } }));
  const d = new AmplifyStaticDelivery({ config: { staging: nextSettings() } });
  assert.throws(() => d.artifact({})); await assert.rejects(d.preflight());
});

test('default cloud transport blocks preparation, dispatch and stale HTTP evidence without AWS calls', async t => {
  const f = await nextFixture(t);
  const forbidden = () => assert.fail('unconfigured cloud staging must not make external calls');
  const d = new NextStagingDelivery({ config: { staging: f.settings },repo: f.h.repo,verifier: f.verifier,git: f.git,execute: forbidden,request: forbidden });
  assert.equal(d.available(),false);
  await assert.rejects(d.preflight(),/immutable release transport/);
  assert.equal(d.prepare(f.task).state,'blocked');
  for (const state of ['ready','running','succeeded']) {
    f.h.repo.store.run('UPDATE staging_deliveries SET state=? WHERE task_id=?',[state,f.task.id]);
    assert.equal((await d.verifyDeployed(f.task)).ok,false);
    assert.equal((await d.advance(f.task)).state,'blocked');
  }
  const adapter = new NextAmplifyStaging({ settings: f.settings,execute: forbidden });
  await assert.rejects(adapter.start(f.task.git_end_commit),/immutable release transport/);
  await assert.rejects(adapter.call('start-job'),/immutable release transport/);
});

test('Next preflight rejects observed wrong account/app/branch/repository/platform and operational bindings', async () => {
  const settings = nextSettings();
  const valid = cloudObjects(settings);
  const d = new NextAmplifyStaging({ settings });
  let current = structuredClone(valid);
  d.call = async op => op === 'get-app' ? { app: current.app } : { branch: current.branch };
  await d.observeTarget();
  for (const [object,key,value] of [['app','appArn','arn:aws:amplify:ap-northeast-1:999999999999:apps/dnexttest'],['app','name','wrong'],['app','repository','https://github.com/example/wrong'],['app','platform','WEB'],['branch','branchName','production'],['branch','backendEnvironmentArn','backend'],['branch','computeRoleArn','operational-role'],['branch','enableAutoBuild',true],['app','environmentVariables',{ BELLO_DATA_SCOPE_ID: 'operational-data' }],['app','buildSpec','backend:\n phases: {}']]) {
    current = structuredClone(valid); current[object][key] = value; await assert.rejects(d.observeTarget(),key);
  }
  d.call = async () => { throw Error('AWS access denied'); }; await assert.rejects(d.observeTarget());
});

test('HTTP identity checks every identifier and rejects redirects/HTML/oversized responses', async () => {
  const settings = nextSettings();
  const expected = { revision: 'a'.repeat(40), deploymentId: '71', environmentId: settings.environmentId, dataScopeId: settings.dataScopeId, verificationFingerprint: 'b'.repeat(64) };
  await readRevision({ settings,expected,request: async url => { assert.equal(url.searchParams.get('revision'),null); assert.ok(url.searchParams.get('eco_check')); return Response.json(expected); } });
  for (const key of Object.keys(expected)) await assert.rejects(readRevision({ settings,expected,request: async () => Response.json({ ...expected,[key]: 'wrong' }) }));
  for (const response of [new Response('<html>fixed</html>'),new Response('{}',{ status: 302 }),Response.json({ ...expected,padding: 'x'.repeat(9000) })])
    await assert.rejects(readRevision({ settings,expected,request: async () => response }));
});

test('verified commit + fingerprint + cloud job + real HTTP receipt survive restart without duplicate start', async t => {
  const f = await nextFixture(t); let starts = 0;
  const adapter = { preflight: async () => {}, start: async commit => { assert.equal(commit,f.task.git_end_commit); starts++; return '71'; }, poll: async () => ({ jobId: '71', commitId: f.task.git_end_commit, status: 'SUCCEED' }) };
  const options = { config: { staging: f.settings },repo: f.h.repo,verifier: f.verifier,git: f.git,adapterFactory: () => adapter,request: async () => Response.json(f.expected()) };
  let d = new NextStagingDelivery(options);
  assert.equal(d.prepare(f.task).state,'ready');
  const running = await d.advance(f.task);
  assert.equal(running.state,'running'); assert.equal(running.commit_id,f.task.git_end_commit);
  d = new NextStagingDelivery(options);
  assert.equal(d.prepare(f.task).state,'running');
  assert.equal((await d.advance(f.task)).state,'succeeded');
  const saved = JSON.parse(d.row(f.task.id).config_json);
  assert.deepEqual(saved.source,{ commit: f.task.git_end_commit,fingerprint: 'b'.repeat(64),plan: 'c'.repeat(64) });
  assert.equal(saved.http.deploymentId,'71'); assert.equal(starts,1);
  assert.equal((await d.verifyDeployed(f.task)).ok,true);
  d.request = async () => Response.json({ ...f.expected(),revision: 'e'.repeat(40) });
  assert.equal((await d.verifyDeployed(f.task)).ok,false);
});

test('unpublished, wrong job revision, dispatch uncertainty, permission failure and retry never imply health', async t => {
  const f = await nextFixture(t); let starts = 0, denied = true;
  const adapter = { preflight: async () => { if (denied) throw Error('AWS denied'); },start: async () => { starts++; return '71'; },poll: async () => ({ jobId: '71',commitId: 'e'.repeat(40),status: 'SUCCEED' }) };
  const d = new NextStagingDelivery({ config: { staging: f.settings },repo: f.h.repo,verifier: f.verifier,git: f.git,adapterFactory: () => adapter,request: async () => { throw Error('Must not accept a wrong job'); } });
  d.prepare(f.task); assert.equal((await d.advance(f.task)).state,'blocked'); assert.equal(starts,0);
  denied = false;
  assert.equal(d.prepare(f.task).state,'ready');
  d.git = (cwd,args) => args[0] === 'ls-remote' ? { ok: true,stdout: 'd'.repeat(40) } : f.git(cwd,args);
  assert.equal((await d.advance(f.task)).state,'blocked'); assert.equal(starts,0);
  d.git = f.git; d.prepare(f.task);
  assert.equal((await d.advance(f.task)).state,'running');
  assert.equal((await d.advance(f.task)).state,'blocked'); assert.equal(starts,1);
  // A saved starting request is never dispatched again, even after restart.
  f.h.repo.store.run('UPDATE staging_deliveries SET state=? WHERE task_id=?',['starting',f.task.id]);
  assert.equal((await d.advance(f.task)).state,'blocked'); assert.equal(starts,1);
});

test('HTTP failure can resume polling; changed verification/source or static package cannot ship', async t => {
  const f = await nextFixture(t); let ready = false;
  const adapter = { preflight: async () => {},start: async () => '71',poll: async () => ({ jobId: '71',commitId: f.task.git_end_commit,status: 'SUCCEED' }) };
  const d = new NextStagingDelivery({ config: { staging: f.settings },repo: f.h.repo,verifier: f.verifier,git: f.git,adapterFactory: () => adapter,request: async () => Response.json(ready ? f.expected() : { ...f.expected(),dataScopeId: 'wrong' }) });
  d.prepare(f.task); await d.advance(f.task);
  assert.equal((await d.advance(f.task)).state,'running');
  ready = true; assert.equal((await d.advance(f.task)).state,'succeeded');
  f.verification.receipt.fingerprint = 'd'.repeat(64);
  assert.equal((await d.verifyDeployed(f.task)).ok,false);
  fs.writeFileSync(path.join(f.task.work_dir,'unexpected.txt'),'dirty');
  assert.throws(() => d.source(f.task));
  const g = await nextFixture(t);
  const staticGit = (cwd,args) => args[0] === 'show' && args[1].endsWith(':package.json') ? { ok: true,stdout: '{}' } : g.git(cwd,args);
  assert.equal(new NextStagingDelivery({ config: { staging: g.settings },repo: g.h.repo,verifier: g.verifier,git: staticGit }).prepare(g.task).state,'blocked');
});

test('lost cloud start response remains non-retryable even with no returned job ID', async t => {
  const f = await nextFixture(t); let starts = 0;
  const d = new NextStagingDelivery({ config: { staging: f.settings },repo: f.h.repo,verifier: f.verifier,git: f.git,
    adapterFactory: () => ({ preflight: async () => {},start: async () => { starts++; throw Error('response lost'); } }) });
  d.prepare(f.task); assert.equal((await d.advance(f.task)).state,'blocked');
  assert.equal(d.row(f.task.id).job_id,null);
  assert.equal(d.prepare(f.task).state,'blocked');
  assert.equal((await d.advance(f.task)).state,'blocked'); assert.equal(starts,1);
});

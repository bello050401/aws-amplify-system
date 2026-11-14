import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceBindings, validateRuntimeConfig } from '../src/eco/serviceBindings.mjs';
import { runQaSession } from '../src/eco/browserWorker.mjs';
import { hash } from '../src/eco/policy.mjs';
import { digest } from '../src/pipeline/staticStaging.mjs';

function localProfile(root = path.resolve(os.tmpdir(),'target-profile-validation')) {
  const staging = { mode: 'local-next-isolated',framework: 'nextjs',service: 'inventory_web',enabled: true,isolatedDataConfirmed: true,
    hostname: '127.0.0.1',port: 4567,dataRoot: path.join(root,'isolated'),hostAdapterPath: path.join(root,'host.cjs'),hostAdapterSha256: 'a'.repeat(64),
    dataAdapter: { kind: 'fixture',id: 'dedicated-fixture' },executionPolicyId: 'test-policy',environmentId: 'inventory-foundation',dataScopeId: 'inventory-fixture',
    operationalDataRoots: [path.join(root,'photo')],operationalPorts: [4321],operationalDataScopeIds: ['photo-data'],qaUrl: 'http://127.0.0.1:4567/',revisionPath: '/api/revision' };
  staging.hostApproval = { approved: true,approvalId: 'host-test',...structuredClone(Object.fromEntries(['hostname','port','dataRoot','hostAdapterPath','hostAdapterSha256','executionPolicyId','environmentId','dataScopeId','qaUrl','revisionPath','dataAdapter','operationalDataRoots','operationalPorts','operationalDataScopeIds'].map(key => [key,staging[key]]))) };
  return { targetApp: 'inventory_web',repoPath: path.join(root,'repo'),allowedPaths: ['app/page.js'],
    verification: { required: true,commands: [{ name: 'independent',file: 'node',args: ['--version'],timeoutSeconds: 10 }] },
    models: { codex: { model: 'gpt-6.1-sol',reasoningEffort: 'medium' } },implementationProvider: 'codex',
    qaUrl: staging.qaUrl,allowedDomains: ['127.0.0.1'],staging,playwright: { modulePath: fileURLToPath(import.meta.url) },
    qaSteps: { sequence: [{ type: 'navigate' },{ type: 'reload' },{ type: 'screenshot' }],maxTotalSeconds: 30 } };
}

test('inventory local Next.js is explicit; mode/target/URL/domain changes cannot fall back', () => {
  const entry = localProfile();
  const validate = value => validateRuntimeConfig({ schemaVersion: 1,profiles: { inventory_web: value } },{ repoPath: entry.repoPath });
  assert.equal(validate(entry).staging.mode,'local-next-isolated');
  for (const change of [p => p.staging.mode = 'unknown',p => p.staging.mode = 'static-smoke',p => p.staging.mode = 'production',p => p.staging.service = 'ec',p => p.qaUrl = 'http://127.0.0.1:4568/',p => p.allowedDomains.push('example.com'),p => delete p.staging.hostApproval]) {
    const value = structuredClone(entry); change(value); assert.throws(() => validate(value));
  }
});

test('cached exact-profile capability expires immediately when the pinned host changes or disappears', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bello-next-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = localProfile(root);
  const config = { repoPath: entry.repoPath };
  const runtime = { schemaVersion: 1, profiles: { inventory_web: entry } };
  const staging = entry.staging;
  fs.mkdirSync(entry.repoPath);
  fs.mkdirSync(staging.dataRoot);
  const adapter = "const fail = () => { throw Error('capability reads must not launch'); }; module.exports = { preflight:fail,start:fail,inspect:fail,stop:fail,runVerification:fail,probeBrowser:fail,captureQaSession:fail };";
  staging.hostAdapterSha256 = staging.hostApproval.hostAdapterSha256 = digest(adapter);
  fs.writeFileSync(staging.hostAdapterPath, adapter);
  fs.writeFileSync(path.join(root, 'eco-runtime.json'), JSON.stringify(runtime));
  const profileHash = hash(validateRuntimeConfig(runtime, config));
  const at = Date.now();
  const probes = { profileHash, codex: { ok: true, at, account: 'chatgpt' }, browser: { ok: true, at }, staging: { ok: true, at } };
  const probesFile = path.join(root, 'eco-probes.json');
  const bindings = createServiceBindings({ config, paths: { dataRoot: root, stateDir: root }, repo: {}, resolveCodex: () => null });
  fs.writeFileSync(probesFile, JSON.stringify({ ...probes, profileHash: 'different-profile' }));
  assert.equal(bindings.capabilities().staging.connected, false);
  fs.writeFileSync(probesFile, JSON.stringify(probes));
  assert.equal(bindings.capabilities().staging.connected, true);
  assert.equal(bindings.capabilities().browserQa.connected, true);
  fs.writeFileSync(staging.hostAdapterPath, adapter + '\n');
  assert.equal(bindings.capabilities().staging.connected, false);
  assert.equal(bindings.capabilities().browserQa.connected, false);
  fs.unlinkSync(staging.hostAdapterPath);
  assert.equal(bindings.capabilities().staging.connected, false);
  const missingHost = createServiceBindings({ config, paths: { dataRoot: root, stateDir: root }, repo: {}, resolveCodex: () => null });
  assert.equal(missingHost.capabilities().staging.connected, false);
});

test('photo and store simulator preserve local evidence and reject a loopback browser target', () => {
  for (const targetApp of ['photo_station','store_simulator']) {
    const entry = { targetApp,repoPath: path.resolve(os.tmpdir(),'local-evidence-profile'),allowedPaths: ['src/main.js'],
      verification: { required: true,commands: [{ name: 'test',file: 'node',args: ['--version'] }] },models: { codex: { model: 'gpt-test' } },
      staging: { mode: 'local-build-evidence',enabled: true,isolatedDataConfirmed: true,uiEvidencePath: 'evidence/ui.png' } };
    const validate = value => validateRuntimeConfig({ schemaVersion: 1,profiles: { [targetApp]: value } },{ repoPath: entry.repoPath });
    assert.equal(validate(entry).evidenceMode,'local');
    assert.throws(() => validate({ ...entry,qaUrl: 'http://127.0.0.1:4567/' }),/must not declare/);
  }
});

test('isolated browser policy blocks external requests and refuses loopback in ordinary QA', async () => {
  let routeHandler,aborted = false;
  const page = {
    route: async (_pattern,handler) => routeHandler = handler,
    routeWebSocket: async () => {},
    goto: async () => routeHandler({ request: () => ({ url: () => 'https://external.example/test',method: () => 'GET' }),abort: () => { aborted = true; },continue: () => assert.fail('outbound connection must not proceed') }),
  };
  const options = { page,sequence: [{ type: 'navigate' },{ type: 'reload' },{ type: 'screenshot' }],baseUrl: 'http://127.0.0.1:4567/',allowedDomains: ['127.0.0.1'],staticSmoke: false,evidenceDir: os.tmpdir(),localNextIsolated: true };
  await assert.rejects(runQaSession(options),/Disallowed network/); assert.equal(aborted,true);
  page.goto = async () => routeHandler({ request: () => ({ url: () => options.baseUrl,method: () => 'GET' }),abort: () => {},continue: () => assert.fail('ordinary QA must reject HTTP') });
  await assert.rejects(runQaSession({ ...options,localNextIsolated: false }),/Disallowed network/);
});

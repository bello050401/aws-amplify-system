import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NextStagingDelivery, verifiedSource, validateRevisionPath, revisionIdentity, readRevision } from './nextStaging.mjs';
import { digest } from './staticStaging.mjs';
import { runGit } from '../core/git.mjs';
import {CUA_CSP,cuaBoundaryProof} from './cuaBoundary.mjs';
import {FROZEN_HTTP_MODE,validateSaleFixtureContract,isIsolatedLocalMode} from './frozenHttpFixture.mjs';

export const isLoopback = hostname => hostname === '127.0.0.1' || hostname === '[::1]';
const nonempty = value => typeof value === 'string' && !!value.trim();
const inside = (root, target) => { const relative = path.relative(root, target); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

export function assertLocalNextSource(task, git = runGit) {
  if (!task?.work_dir) throw Error('A sanitized local Next.js worktree is required');
  // Inspect names only. Never open production outputs or dotenv/credential files.
  const names = git(task.work_dir,['ls-files','--cached','--others','--exclude-standard','-z']);
  const forbidden = /(^|\/)(?:\.env(?:\.[^/]*)?|amplify_outputs\.json|\.aws)(\/|$)/i;
  if (!names.ok || names.stdoutRaw.split('\0').some(file => forbidden.test(file)) || fs.readdirSync(task.work_dir).some(file => forbidden.test(file)))
    throw Error('Local Next.js requires a sanitized source with no dotenv, production amplify_outputs.json or AWS credential paths');
}

export function validateLocalNextSettings(s) {
  const http=s?.mode===FROZEN_HTTP_MODE;if(http)validateSaleFixtureContract(s);
  if (!isIsolatedLocalMode(s?.mode) || s.enabled !== true || s.framework !== (http?'frozen-http-fixture':'nextjs') || s.isolatedDataConfirmed !== true || s.service !== 'inventory_web')
    throw Error('Explicit local-next-isolated Next.js inventory mode is required');
  if (!isLoopback(s.hostname) || !Number.isInteger(s.port) || s.port < 1024 || s.port > 65535) throw Error('Host-approved loopback address and dedicated unprivileged port are required');
  if (!path.isAbsolute(s.dataRoot || '') || !path.isAbsolute(s.hostAdapterPath || '') || !/^[a-f0-9]{64}$/.test(s.hostAdapterSha256 || '')) throw Error('Dedicated dataRoot and pinned absolute host adapter are required');
  if (!['fixture','local-adapter'].includes(s.dataAdapter?.kind) || !nonempty(s.dataAdapter.id) || !nonempty(s.executionPolicyId) || !nonempty(s.environmentId) || !nonempty(s.dataScopeId)) throw Error('A dedicated fixture/local adapter and enforced isolation policy are required');
  if (!Array.isArray(s.operationalDataRoots) || !s.operationalDataRoots.length || !s.operationalDataRoots.every(p => typeof p === 'string' && path.isAbsolute(p)) || s.operationalDataRoots.some(root => inside(path.resolve(root),path.resolve(s.dataRoot)) || inside(path.resolve(s.dataRoot),path.resolve(root))))
    throw Error('Dedicated dataRoot must be separate from all operational data roots');
  if (!Array.isArray(s.operationalPorts) || !s.operationalPorts.length || !s.operationalPorts.every(Number.isInteger) || s.operationalPorts.includes(s.port)) throw Error('Dedicated port must differ from operational ports');
  if (!Array.isArray(s.operationalDataScopeIds) || !s.operationalDataScopeIds.length || !s.operationalDataScopeIds.every(nonempty) || s.operationalDataScopeIds.includes(s.dataScopeId)) throw Error('Dedicated data scope must differ from operational scopes');
  const approval = s.hostApproval;
  if(http&&(!isDeepStrictEqual(s.fixtureContract,approval?.fixtureContract)||s.mode!==approval.mode||s.framework!==approval.framework))throw Error('Frozen HTTP fixture/mode differs from exact host approval');
  const fields = ['hostname','port','dataRoot','hostAdapterPath','hostAdapterSha256','executionPolicyId','environmentId','dataScopeId','qaUrl','revisionPath','dataAdapter','operationalDataRoots','operationalPorts','operationalDataScopeIds','hostBundle'];
  if (approval?.approved !== true || !nonempty(approval.approvalId) || !fields.every(key => isDeepStrictEqual(s[key], approval[key]))) throw Error('Local target does not match host approval');
  if (s.hostBundle !== undefined && (!path.isAbsolute(s.hostBundle?.descriptorPath || '') || !/^[a-f0-9]{64}$/.test(s.hostBundle?.sha256 || ''))) throw Error('Pinned host bundle descriptor is invalid');
  if (s.accountId || s.appId || s.repository || s.profile || s.branch) throw Error('Local mode cannot inherit a cloud/production target');
  const url = new URL(s.qaUrl);
  if (url.protocol !== 'http:' || url.hostname !== s.hostname || Number(url.port) !== s.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw Error('Local QA URL must match the exact approved loopback origin');
  validateRevisionPath(s.revisionPath);
  return s;
}

// Host adapter is a pinned administrator-owned CJS module, outside worker repos
// and writable data. No repository code or environment variable can supply it.
function checkHostPins(settings, repoPath) {
  const s = validateLocalNextSettings(settings);
  const modulePath = fs.realpathSync(s.hostAdapterPath);
  const protectedRoots = [fs.realpathSync(repoPath), fs.realpathSync(s.dataRoot)];
  if (protectedRoots.some(root => inside(root, modulePath))) throw Error('Isolation adapter must be outside repository and writable dataRoot');
  if (digest(fs.readFileSync(modulePath)) !== s.hostAdapterSha256) throw Error('Host isolation adapter fingerprint mismatch');
  if (s.hostBundle) {
    const descriptor = fs.realpathSync(s.hostBundle.descriptorPath);
    if (protectedRoots.some(root => inside(root, descriptor))) throw Error('Host bundle descriptor must be outside repository and writable dataRoot');
    if (digest(fs.readFileSync(descriptor)) !== s.hostBundle.sha256) throw Error('Host bundle descriptor fingerprint mismatch');
  }
  return modulePath;
}

function assertHostContract(host, settings) {
  const supportsCapture = typeof host?.captureQaSession === 'function' && typeof host?.probeBrowser === 'function';
  if (!['preflight','start','inspect','stop','runVerification'].every(key => typeof host?.[key] === 'function') ||
      (!supportsCapture && typeof host?.launchBrowser !== 'function') ||
      (settings.hostBundle && typeof host?.verifyBundle !== 'function')) throw Error('Host isolation adapter contract is incomplete');
}

export function loadLocalNextHost(settings, repoPath) {
  const host = createRequire(import.meta.url)(checkHostPins(settings, repoPath));
  assertHostContract(host, settings);
  return host;
}

export function assertIsolationProof(proof, settings) {
  const s = validateLocalNextSettings(settings);
  if (proof?.executionPolicyId !== s.executionPolicyId || !nonempty(proof.enforcementId) || proof.dataRoot !== s.dataRoot || proof.hostname !== s.hostname || proof.port !== s.port ||
      proof.network?.outbound !== 'deny' || proof.network?.loopback !== `${s.hostname}:${s.port}` || !nonempty(proof.network.evidenceId) ||
      proof.filesystem?.productionConfig !== 'deny' || proof.filesystem?.operationalData !== 'deny' || !nonempty(proof.filesystem.evidenceId) ||
      proof.credentials?.inheritance !== 'deny' || proof.credentials?.defaultAwsFiles !== 'deny' || proof.credentials?.metadata !== 'deny' || !nonempty(proof.credentials.evidenceId) ||
      proof.runtime?.framework !== s.framework || proof.runtime?.dataAdapterId !== s.dataAdapter.id || proof.runtime?.dataAdapterKind !== s.dataAdapter.kind)
    throw Error('Host-enforced network/filesystem/credentials isolation evidence is missing');
  return proof;
}

export class LocalNextDelivery extends NextStagingDelivery {
  constructor(options) {
    super(options);
    this.repoPath = options.config.repoPath;
    this.injectedHost = options.host != null;
    this.host = options.host ?? null;
    this.advances = new Map();
    this.stops = new Map();
    this.stopRequested = new Set();
    this.shuttingDown = false;
    if (!this.host) {
      try { this.host = loadLocalNextHost(this.settings, this.repoPath); }
      catch { /* Capability stays unavailable. */ }
    }
  }
  checkHost() {
    assertHostContract(this.host, this.settings);
    if (!this.injectedHost) checkHostPins(this.settings, this.repoPath);
  }
  available() {
    try { this.checkHost(); return true; }
    catch { return false; }
  }
  get capturesBrowser() {
    return typeof this.host?.captureQaSession === 'function' && typeof this.host?.probeBrowser === 'function';
  }
  source(task) { validateLocalNextSettings(this.settings); assertLocalNextSource(task,this.git); return verifiedSource(task, this.verifier, this.git); }
  hasApprovedBundle(source) {
    try {
      this.checkHost();
      const bundle = this.host.verifyBundle({ settings: structuredClone(this.settings) });
      return isDeepStrictEqual(bundle.source, source);
    } catch { return false; }
  }
  async preflight({ checkPort = true } = {}) {
    validateLocalNextSettings(this.settings);
    this.checkHost();
    const root = fs.realpathSync(this.settings.dataRoot);
    for (const operational of this.settings.operationalDataRoots) {
      const other = fs.realpathSync(operational);
      if (inside(root,other) || inside(other,root)) throw Error('Canonical data roots overlap; junction/symlink isolation is invalid');
    }
    return assertIsolationProof(await this.host.preflight({ settings: structuredClone(this.settings), checkPort }), this.settings);
  }
  async launchBrowser() {
    this.checkHost();
    const result = await this.host.launchBrowser({ settings: structuredClone(this.settings) });
    try {
      assertIsolationProof(result?.isolation,this.settings);
      if (!result.browser || typeof result.browser.newPage !== 'function' || typeof result.browser.close !== 'function') throw Error('Host-isolated Playwright browser is unavailable');
      return result.browser;
    } catch {
      await result?.browser?.close?.().catch(() => {});
      throw Error('Browser launch lacks host-enforced local isolation');
    }
  }
  async probeBrowser() {
    this.checkHost();
    const proof = await this.host.probeBrowser({ settings: structuredClone(this.settings) });
    assertIsolationProof(proof?.isolation, this.settings);
  }
  async captureQaSession(task, options) {
    this.checkHost();
    const row = this.row(task.id);
    if (this.isStopping(task.id) || row?.state !== 'succeeded' || row.job_id !== options.buildIdentity?.deploymentId ||
        options.baseUrl !== this.settings.qaUrl) throw Error('No matching live local QA deployment');
    this.validateReceipt(task, row);
    const saved = JSON.parse(row.config_json);
    await this.inspect(task, saved);
    const result = await this.host.captureQaSession({ ...options, taskId: task.id, process: structuredClone(saved.process), settings: structuredClone(this.settings) });
    assertIsolationProof(result?.isolation, this.settings);
    if (result.isolation.enforcementId !== saved.process.isolation.enforcementId) throw Error('QA capture used a different enforcement instance');
    await this.inspect(task, saved);
    if (this.isStopping(task.id)) throw Error('QA deployment is stopping');
    return result.session;
  }
  /** Application remains MXC-isolated. The native CUA browser has a distinct, honest boundary. */
  async inspectCuaBoundary(task){
    this.checkHost();const row=this.row(task.id);if(row?.state!=='succeeded'||this.isStopping(task.id))throw Error('No verified CUA fixture deployment');
    this.validateReceipt(task,row);const saved=JSON.parse(row.config_json);await this.inspect(task,saved);
    const response=await this.request(this.settings.qaUrl,{method:'GET',credentials:'omit',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(6000)});
    try{if(response.status!==200||response.redirected||response.headers.get('content-security-policy')!==CUA_CSP||response.headers.get('x-bello-cua-paths')!==this.settings.desktopCua?.servedPathsSha256)throw Error('Pinned read-only CUA CSP/path scope is not enforced');}finally{await response.body?.cancel().catch(()=>{});}
    const observed=await this.inspect(task,saved);if(this.row(task.id)?.job_id!==row.job_id)throw Error('CUA deployment changed');
    return {...cuaBoundaryProof({origin:new URL(this.settings.qaUrl).origin,applicationIsolation:saved.process.isolation,settings:this.settings}),...(this.settings.mode===FROZEN_HTTP_MODE?{fixtureActions:observed.fixtureActions??[]}:{})};
  }
  prepare(task) {
    const existing = this.row(task.id);
    if (this.isStopping(task.id)) return { state: 'blocked', error: 'Local staging is stopping' };
    if (existing) {
      try { if (JSON.parse(existing.config_json).startRequested) return existing; }
      catch { return existing; }
    }
    if (existing && (existing.commit_id !== task.git_end_commit || existing.job_id || existing.state !== 'blocked')) return existing;
    let source, error = null;
    try { source = this.source(task); this.checkHost(); }
    catch (err) { error = err.message; }
    return this.savePrepared(task, source, error);
  }
  savePrepared(task, source, error = null) {
    const now = new Date().toISOString();
    const saved = JSON.stringify({ settings: this.settings, source });
    this.repo.store.run('INSERT INTO staging_deliveries(task_id,commit_id,config_json,state,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET commit_id=excluded.commit_id,config_json=excluded.config_json,state=excluded.state,error=excluded.error,job_id=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at',[task.id,task.git_end_commit || '',saved,error ? 'blocked' : 'ready',error,now,now]);
    return this.row(task.id);
  }
  prepareRevision(task) {
    return this.trackAdvance(task.id, async () => {
      const previous = this.row(task.id);
      if (!previous || previous.commit_id === task.git_end_commit) return this.prepare(task);
      try {
        const source = this.source(task);
        this.checkHost();
        const saved = JSON.parse(previous.config_json);
        if (!this.sameHostTarget(saved.settings)) throw Error('Local target changed');
        await this.stopReceipt(task.id);
        if (this.isStopping(task.id)) return this.row(task.id);
        this.validateRevisionSource(task, source);
        return this.repo.store.transaction(() => {
          const stopped = this.row(task.id);
          const receipt = JSON.parse(stopped.config_json);
          if (stopped.commit_id !== previous.commit_id || (this.hasStart(stopped, receipt) && !receipt.stopped))
            throw Error('Previous deployment still requires reconciliation');
          this.repo.checkpoint(task.id, 'local_next_history', {
            revision: stopped.commit_id, deploymentId: stopped.job_id, state: previous.state,
            startAttemptId: receipt.startAttemptId, stopped: receipt.stopped === true,
            instanceId: receipt.process?.instanceId, http: receipt.http, stoppedAt: receipt.stoppedAt,
          });
          return this.savePrepared(task, source);
        });
      } catch {
        return { state: 'blocked', error: 'Previous local deployment stop and new verified source must be confirmed' };
      }
    });
  }
  validateRevisionSource(task, expected) {
    if (!isDeepStrictEqual(expected, this.source(task))) throw Error('Verified source changed during local staging');
  }
  sameHostTarget(previous) {
    if (!previous) return false;
    const { hostBundle, hostApproval, ...target } = this.settings;
    const { hostBundle: oldBundle, hostApproval: oldApproval, ...oldTarget } = previous;
    const { hostBundle: approvedBundle, ...approval } = hostApproval;
    const { hostBundle: oldApprovedBundle, ...previousApproval } = oldApproval ?? {};
    return isDeepStrictEqual(target, oldTarget) && isDeepStrictEqual(approval, previousApproval);
  }
  hasStart(row, saved) {
    return !!(saved.startRequested || saved.process || row.state === 'starting' || row.job_id);
  }
  isStopping(taskId) {
    return this.shuttingDown || this.stopRequested.has(taskId);
  }
  trackAdvance(taskId, execute) {
    const active = this.advances.get(taskId);
    if (active) return active;
    const pending = Promise.resolve().then(execute).finally(() => this.advances.delete(taskId));
    this.advances.set(taskId, pending);
    return pending;
  }
  update(task, state, error = null) {
    this.repo.store.run('UPDATE staging_deliveries SET state=?,error=?,updated_at=? WHERE task_id=?',[state,error,new Date().toISOString(),task.id]);
    return this.row(task.id);
  }
  async inspect(task, saved) {
    if (!saved.process || !this.host) throw Error('No host process receipt; manual reconciliation required');
    assertIsolationProof(saved.process.isolation, this.settings);
    const observed = await this.host.inspect({ taskId: task.id, process: structuredClone(saved.process), settings: structuredClone(this.settings) });
    const expected = { ...revisionIdentity(this.settings,saved.source,saved.process.deploymentId), pid: saved.process.pid, port: this.settings.port, hostname: this.settings.hostname, instanceId: saved.process.instanceId };
    if (!Number.isInteger(expected.pid) || expected.pid <= 0 || !nonempty(expected.instanceId) || !nonempty(expected.deploymentId) || observed?.running !== true ||
        !Object.entries(expected).every(([key,value]) => observed[key] === value)) throw Error('Live PID/port/instance/revision does not match the host process receipt');
    assertIsolationProof(observed.isolation, this.settings);
    if (observed.isolation.enforcementId !== saved.process.isolation.enforcementId) throw Error('Process enforcement instance changed');
    return observed;
  }
  async verifyPublication(task, row) {
    this.checkHost();
    if (this.isStopping(task.id)) throw Error('Local deployment is stopping');
    this.validateReceipt(task,row);
    const saved = JSON.parse(row.config_json);
    if (saved.stopped || saved.process?.deploymentId !== row.job_id) throw Error('Local process is stopped or belongs to another deployment');
    await this.inspect(task,saved);
    const proof = await readRevision({ settings: this.settings, expected: revisionIdentity(this.settings,saved.source,row.job_id), request: this.request });
    await this.inspect(task,saved);
    const current = this.row(task.id);
    if (this.isStopping(task.id) || current?.job_id !== row.job_id || current.commit_id !== row.commit_id || current.state !== row.state)
      throw Error('Local deployment changed during live verification');
    this.validateReceipt(task,row);
    const evidence = { ...proof, pid: saved.process.pid, port: this.settings.port, instanceId: saved.process.instanceId, enforcementId: saved.process.isolation.enforcementId };
    this.repo.checkpoint(task.id,'local_next_http',evidence);
    this.repo.store.run('UPDATE staging_deliveries SET config_json=? WHERE task_id=?',[JSON.stringify({ ...saved,http: evidence }),task.id]);
    return evidence;
  }
  advance(task) {
    return this.trackAdvance(task.id, () => this.advanceCurrent(task));
  }
  async advanceCurrent(task) {
    const row = this.row(task.id);
    if (this.isStopping(task.id)) return row ?? { state: 'blocked', error: 'Local staging is stopping' };
    if (!row || ['blocked','failed','succeeded'].includes(row.state)) return row ?? { state: 'blocked', error: 'No local process receipt' };
    if (row.state === 'starting') return this.update(task,'blocked','Start interrupted; inspect host task receipt before any retry');
    try {
      this.validateReceipt(task,row);
      if (row.state === 'ready') {
        await this.preflight();
        if (this.isStopping(task.id)) return this.row(task.id);
        this.validateReceipt(task,row);
        const saved = { ...JSON.parse(row.config_json), startRequested: true, startAttemptId: randomUUID() };
        const claim = this.repo.store.run("UPDATE staging_deliveries SET config_json=?,state='starting',updated_at=? WHERE task_id=? AND state='ready' AND commit_id=? AND config_json=?",[JSON.stringify(saved),new Date().toISOString(),task.id,row.commit_id,row.config_json]);
        if (!claim.changes) return this.row(task.id);
        const processReceipt = await this.host.start({ taskId: task.id, startAttemptId: saved.startAttemptId, source: structuredClone(saved.source), workDir: task.work_dir, settings: structuredClone(this.settings) });
        // Persist even a malformed response; an ambiguous start must not redispatch.
        const recorded = this.repo.store.run("UPDATE staging_deliveries SET config_json=?,job_id=?,updated_at=? WHERE task_id=? AND state='starting' AND config_json=?",[JSON.stringify({ ...saved,process: processReceipt }),typeof processReceipt?.deploymentId === 'string' ? processReceipt.deploymentId : null,new Date().toISOString(),task.id,JSON.stringify(saved)]);
        if (!recorded.changes || this.isStopping(task.id)) return this.row(task.id);
        await this.inspect(task,{ ...saved,process: processReceipt });
        if (this.isStopping(task.id)) return this.row(task.id);
        return this.update(task,'running');
      }
      await this.verifyPublication(task,row);
      if (this.isStopping(task.id)) return this.row(task.id);
      return this.update(task,'succeeded');
    } catch {
      const current = this.row(task.id);
      if (this.isStopping(task.id)) return current;
      if (current.state === 'starting') {
        await this.stopReceipt(task.id).catch(() => {});
        return this.update(task,'blocked','Start outcome uncertain; host stop/reconciliation is required before retry');
      }
      if (current.state === 'running' && Date.now() - Date.parse(row.created_at) < (this.settings.maxWaitSeconds || 120) * 1000)
        return this.update(task,'running','Waiting for matching live process and HTTP revision; health has not passed');
      if (current.job_id) await this.stopReceipt(task.id).catch(() => {});
      return this.update(task,'blocked','Local Next.js source, isolation, process or HTTP verification failed');
    }
  }
  stopTask(taskId) {
    this.stopRequested.add(taskId);
    const active = this.stops.get(taskId);
    if (active) return active;
    const pending = Promise.resolve(this.advances.get(taskId)).catch(() => {})
      .then(() => this.stopReceipt(taskId, true)).finally(() => this.stops.delete(taskId));
    this.stops.set(taskId, pending);
    return pending;
  }
  async stopReceipt(taskId, blockUnstarted = false) {
    const row = this.row(taskId);
    if (!row) return;
    const saved = JSON.parse(row.config_json);
    if (saved.stopped) return;
    if (!this.hasStart(row, saved)) {
      if (blockUnstarted) this.update({ id: taskId }, 'blocked', 'Local staging stopped before dispatch');
      return;
    }
    assertHostContract(this.host, this.settings);
    if (!this.sameHostTarget(saved.settings)) throw Error('Cannot stop a process owned by a different host adapter or target');
    // The host resolves by taskId even when start's response was lost. It must
    // verify PID+instance ownership, kill its process tree, and confirm port closure.
    const result = await this.host.stop({ taskId, startAttemptId: saved.startAttemptId, process: structuredClone(saved.process ?? null), settings: structuredClone(saved.settings) });
    if (result?.stopped !== true || result.portClosed !== true) throw Error('Host could not confirm process stop and port closure');
    const stoppedAt = new Date().toISOString();
    this.repo.store.run('UPDATE staging_deliveries SET config_json=?,state=?,error=?,updated_at=? WHERE task_id=? AND config_json=?',[JSON.stringify({ ...saved,stopped: true,stoppedAt }),'blocked','Local process stopped; evidence is historical',stoppedAt,taskId,row.config_json]);
  }
  async stop() {
    this.shuttingDown = true;
    const tasks = new Set([...this.advances.keys(),...this.stops.keys()]);
    for (const row of this.repo.store.all('SELECT * FROM staging_deliveries')) {
      let saved; try { saved = JSON.parse(row.config_json); } catch { continue; }
      if (this.sameHostTarget(saved.settings) && !saved.stopped && this.hasStart(row,saved)) tasks.add(row.task_id);
    }
    const results = await Promise.allSettled([...tasks].map(taskId => this.stopTask(taskId)));
    if (results.some(result => result.status === 'rejected')) throw Error('Local Next.js stop requires host reconciliation');
  }
}

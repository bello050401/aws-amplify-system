import { StagingDelivery, AmplifyStaging, stagingPolicy } from './staging.mjs';
import { runGit } from '../core/git.mjs';
import { digest } from './staticStaging.mjs';
import { randomUUID } from 'node:crypto';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const isRevision = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const nonempty = value => typeof value === 'string' && !!value.trim();
const identityFields = ['service','accountId','region','appId','appName','branch','repository','environment','stagingId','environmentId','dataScopeId','qaUrl','profile','revisionPath'];
const noReleaseTransport = 'Next.js cloud staging requires a trusted immutable release transport';

// This approval is host-owned configuration, outside every worker's edit scope.
// Names and environment variables alone cannot attest to data isolation.
export function validateNextSettings(s) {
  if (s?.mode !== 'real-staging' || s.framework !== 'nextjs' || s.enabled !== true || s.isolatedDataConfirmed !== true)
    throw Error('real-staging requires an explicitly approved Next.js target');
  if (!['inventory_web','ec','zaico'].includes(s.service) || s.appId === 'd4hkkg7dty2du') throw Error('Operational or unknown app is forbidden');
  const policy = stagingPolicy(s, { isolation: 'worktree', git_end_commit: 'a'.repeat(40) }, []);
  if (policy) throw Error(policy);
  if (!identityFields.every(key => nonempty(s[key])) || !nonempty(s.profile)) throw Error('Next.js target identity/profile is incomplete');
  const approval = s.hostApproval;
  if (approval?.approved !== true || approval.purpose !== 'verification-only' || !nonempty(approval.approvalId) || !identityFields.every(key => approval[key] === s[key]))
    throw Error('Host approval does not match account/app/branch/repository/environment/data scope/URL');
  if (/(^|[-_/])(prod(?:uction)?|live)([-_/]|$)/i.test(s.environment)) throw Error('Production environments are forbidden');
  const isolation = approval.isolation;
  if (isolation?.dedicated !== true || isolation.productionDataAccess !== false || !nonempty(isolation.evidenceId) || !nonempty(isolation.verifiedBy) ||
      !Array.isArray(isolation.resourceIds) || !isolation.resourceIds.length || !isolation.resourceIds.every(nonempty) ||
      !Array.isArray(isolation.operationalResourceIds) || !isolation.operationalResourceIds.length || !isolation.operationalResourceIds.every(nonempty) ||
      isolation.resourceIds.some(id => isolation.operationalResourceIds.includes(id)) ||
      !Array.isArray(isolation.operationalDataScopeIds) || !isolation.operationalDataScopeIds.length || !isolation.operationalDataScopeIds.every(nonempty) || isolation.operationalDataScopeIds.includes(s.dataScopeId))
    throw Error('Dedicated resources and denied operational data access require host isolation evidence');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(s.repository)) throw Error('Invalid approved repository');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(s.region)) throw Error('Invalid region');
  const url = new URL(s.qaUrl);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      url.hostname !== `${s.branch}.${s.appId}.amplifyapp.com` || url.pathname !== '/') throw Error('QA URL must be the exact dedicated Amplify branch origin');
  validateRevisionPath(s.revisionPath);
  return s;
}

export function validateRevisionPath(value) {
  if (typeof value !== 'string' || !/^\/[a-z0-9/_-]+$/i.test(value) || value.includes('//') || value.includes('..'))
    throw Error('An explicit same-origin revision API path is required');
}

export function verifiedSource(task, verifier, git = runGit) {
  if (task.isolation !== 'worktree' || !task.work_dir || !isRevision(task.git_end_commit) || verifier.required !== true)
    throw Error('Independent worktree verification of an exact commit is required');
  const result = verifier.check(task);
  if (result.passed !== true || result.receipt?.passed !== true || !/^[a-f0-9]{64}$/.test(result.receipt.fingerprint || '') || !/^[a-f0-9]{64}$/.test(result.receipt.plan || ''))
    throw Error('Independent verification fingerprint and plan are required');
  const head = git(task.work_dir, ['rev-parse','HEAD']);
  const status = git(task.work_dir, ['status','--porcelain']);
  if (!head.ok || head.stdout.trim() !== task.git_end_commit || !status.ok || status.stdout.trim()) throw Error('Verified commit must be the exact clean worktree HEAD');
  const pkg = git(task.work_dir, ['show', `${task.git_end_commit}:package.json`]);
  let manifest;
  try { manifest = JSON.parse(pkg.stdout); } catch { throw Error('Committed Next.js package.json is required'); }
  if (!pkg.ok || !(manifest.dependencies?.next || manifest.devDependencies?.next)) throw Error('Static applications cannot use the Next.js adapter');
  const pages = git(task.work_dir, ['ls-tree','-r','--name-only',task.git_end_commit]);
  if (!pages.ok || !/(?:^|\n)(?:src\/)?(?:app\/(?:.*\/)?page\.[cm]?[jt]sx?|pages\/(?!api\/).+\.[cm]?[jt]sx?)(?:\r?\n|$)/.test(pages.stdout))
    throw Error('A committed real Next.js page is required');
  return { commit: task.git_end_commit, fingerprint: result.receipt.fingerprint, plan: result.receipt.plan };
}

export function revisionIdentity(settings, source, deploymentId) {
  return { revision: source.commit, deploymentId, environmentId: settings.environmentId, dataScopeId: settings.dataScopeId, verificationFingerprint: source.fingerprint };
}

export async function readRevision({ settings, expected, request = fetch }) {
  if (!isRevision(expected?.revision) || !/^[a-f0-9]{64}$/.test(expected?.verificationFingerprint || '') || !['deploymentId','environmentId','dataScopeId'].every(key => nonempty(expected[key]))) throw Error('Complete expected revision identity is required');
  const url = new URL(settings.revisionPath, settings.qaUrl);
  // Never send the expected identifiers to an endpoint that might echo them.
  url.searchParams.set('eco_check', randomUUID());
  const response = await request(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw Error('Revision API is unavailable or is not JSON');
  if (response.url && new URL(response.url).origin !== url.origin) throw Error('Revision API left the approved origin');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    bytes += part.value.length;
    if (bytes > 8192) { await reader.cancel(); throw Error('Revision response exceeds limit'); }
    chunks.push(part.value);
  }
  let observed;
  try { observed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('Invalid revision JSON'); }
  if (!Object.keys(expected).every(key => observed[key] === expected[key])) throw Error('HTTP revision/deployment/environment/data scope/fingerprint mismatch');
  return { ...expected, url: url.href, status: response.status, observedAt: new Date().toISOString() };
}

export class NextAmplifyStaging extends AmplifyStaging {
  async preflight() { throw Error(noReleaseTransport); }
  async start() { throw Error(noReleaseTransport); }
  async call(operation, args) {
    if (operation === 'start-job') throw Error(noReleaseTransport);
    return super.call(operation, args);
  }
  async observeTarget() {
    const s = validateNextSettings(this.settings);
    const { app, branch } = await super.preflight();
    const approval = s.hostApproval;
    if (app.appArn !== `arn:aws:amplify:${s.region}:${s.accountId}:apps/${s.appId}` || app.name !== s.appName || app.platform !== 'WEB_COMPUTE' || branch.framework !== 'Next.js - SSR')
      throw Error('Account/app/platform/Next.js branch mismatch');
    if (branch.backendEnvironmentArn || branch.backend?.stackArn || app.enableBranchAutoBuild !== false || branch.enableAutoBuild !== false || branch.stage !== 'DEVELOPMENT') throw Error('Operational/backend/automatic deployment is forbidden');
    for (const key of ['iamServiceRoleArn','computeRoleArn']) {
      if ((app[key] || '') !== (approval[key] || '') || (branch[key] || '') !== (approval.branchRoles?.[key] || '')) throw Error('Unapproved deployment role');
    }
    const variables = { BELLO_ENVIRONMENT_ID: s.environmentId, BELLO_DATA_SCOPE_ID: s.dataScopeId, BELLO_ISOLATION_EVIDENCE_ID: approval.isolation.evidenceId };
    if (Object.keys(app.environmentVariables || {}).length !== Object.keys(variables).length || !Object.entries(variables).every(([key,value]) => app.environmentVariables?.[key] === value) || Object.keys(branch.environmentVariables || {}).length) throw Error('Unapproved runtime configuration');
  }
}

export class NextStagingDelivery extends StagingDelivery {
  constructor(options) {
    super({ ...options, adapterFactory: options.adapterFactory ?? (settings => new NextAmplifyStaging({ settings, execute: options.execute })) });
    this.request = options.request ?? fetch;
    this.releaseTransportAvailable = typeof options.adapterFactory === 'function';
    this.requirePublished = true;
    this.revisionContract = true;
  }
  source(task) { validateNextSettings(this.settings); return verifiedSource(task, this.verifier, this.git); }
  available() { return this.releaseTransportAvailable; }
  async preflight() {
    if (!this.available()) throw Error(noReleaseTransport);
    return super.preflight();
  }
  async advance(task) {
    if (this.available()) return super.advance(task);
    this.repo.store.run("UPDATE staging_deliveries SET state='blocked',error=?,updated_at=? WHERE task_id=?",[noReleaseTransport,new Date().toISOString(),task.id]);
    return this.row(task.id) ?? { state: 'blocked', error: noReleaseTransport };
  }
  prepare(task) {
    const existing = this.row(task.id);
    if (existing) {
      try { if (JSON.parse(existing.config_json).dispatchAttempted) return existing; }
      catch { return existing; }
    }
    if (existing && (existing.job_id || existing.state !== 'blocked')) return existing;
    let source;
    try {
      if (!this.available()) throw Error(noReleaseTransport);
      source = this.source(task);
    }
    catch (error) {
      if (!existing) {
        const now = new Date().toISOString();
        this.repo.store.run('INSERT INTO staging_deliveries(task_id,commit_id,config_json,state,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [task.id,task.git_end_commit || '',JSON.stringify({ settings: this.settings }),'blocked',error.message,now,now]);
      }
      return this.row(task.id);
    }
    const row = super.prepare(task);
    if (row.state === 'ready') this.repo.store.run('UPDATE staging_deliveries SET config_json=? WHERE task_id=?',[JSON.stringify({ settings: this.settings, source }),task.id]);
    return this.row(task.id);
  }
  validateReceipt(task, row) {
    const saved = JSON.parse(row.config_json);
    if (row.commit_id !== task.git_end_commit || !same(saved.settings, this.settings) || !same(saved.source, this.source(task))) throw Error('Verified source or target changed after preparation');
  }
  async verifyPublication(task, row) {
    this.validateReceipt(task, row);
    await this.preflight();
    const saved = JSON.parse(row.config_json);
    const proof = await readRevision({ settings: this.settings, expected: revisionIdentity(this.settings, saved.source, row.job_id), request: this.request });
    this.validateReceipt(task, row);
    this.repo.checkpoint(task.id, 'next_http', proof);
    this.repo.store.run('UPDATE staging_deliveries SET config_json=? WHERE task_id=?',[JSON.stringify({ ...saved, http: proof }),task.id]);
    return proof;
  }
  async verifyDeployed(task) {
    const row = this.row(task.id);
    if (row?.state !== 'succeeded') return { ok: false, reason: 'Next.js delivery has not passed real HTTP verification' };
    try {
      const proof = await this.verifyPublication(task, row);
      return { ok: true, sha256: digest(JSON.stringify(revisionIdentity(this.settings, { commit: proof.revision, fingerprint: proof.verificationFingerprint }, proof.deploymentId))), identity: proof };
    } catch { return { ok: false, reason: 'Next.js revision or isolation could not be verified over HTTP' }; }
  }
}

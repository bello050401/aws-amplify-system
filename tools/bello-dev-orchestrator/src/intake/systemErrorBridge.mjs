import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function assertLocalOrchestratorUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Pinned loopback Orchestrator URL required');
  return url.origin;
}

export class SystemErrorBridge {
  constructor({queue, request, now = Date.now, intakeOnly = false}) {this.queue = queue; this.request = request; this.now = now; this.cursor = undefined; this.intakeOnly = intakeOnly;}
  async once() {
    const page = await this.queue.list(this.cursor, this.now());
    this.cursor = page.cursor || undefined;
    const summary = {seen: page.events.length, dispatched: 0, needsOperator: 0, verifiedLocal: 0};
    for (const event of page.events) {
      if (event.state === 'CLAIMED' && event.leaseUntil < this.now() && event.attempts >= 3) {
        try {await this.queue.markExhausted(event.id,this.now());summary.needsOperator++;}
        catch (error) {if(error?.name !== 'ConditionalCheckFailedException') throw error;}
        continue;
      }
      if (!this.intakeOnly && event.state === 'DISPATCHED' && event.runId && event.lease) {
        const response = await this.request('GET', `/api/eco/runs/${event.runId}`);
        const state = response.run?.state;
        if (state === 'COMPLETED_STAGING') {
          await this.queue.acknowledge(event.id, event.lease, 'VERIFIED_LOCAL', event.taskId, event.runId, 'LOCAL_CHECKS_PASSED'); summary.verifiedLocal++;
        } else if (['FAILED','CANCELLED'].includes(state)) {
          await this.queue.acknowledge(event.id, event.lease, 'FAILED', event.taskId, event.runId, 'REPAIR_FAILED');
        } else if (['WAITING_APPROVAL','WAITING_USER_AUTH','WAITING_CAPACITY','HUMAN_REVIEW','PAUSED'].includes(state)) {
          // Keep DISPATCHED so an operator's reviewed continuation is tracked.
          await this.queue.acknowledge(event.id, event.lease, 'DISPATCHED', event.taskId, event.runId, state === 'WAITING_APPROVAL' ? 'AWAITING_APPROVAL' : 'PROVIDER_BLOCKED'); summary.needsOperator++;
        }
        continue;
      }
      if (event.state !== 'PENDING' && !(event.state === 'CLAIMED' && event.leaseUntil < this.now() && event.attempts < 3)) continue;
      let claimed;
      try {claimed = await this.queue.claim(event.id, this.now());}
      catch (error) {if (error?.name === 'ConditionalCheckFailedException') continue; throw error;}
      if (this.intakeOnly) {
        await this.queue.acknowledge(event.id,claimed.lease,'NEEDS_OPERATOR',undefined,undefined,'PROFILE_REQUIRED');summary.needsOperator++;continue;
      }
      let result;
      try {result = await this.request('POST', '/api/eco/system-error', claimed.event);}
      catch {
        await this.queue.acknowledge(event.id, claimed.lease, 'NEEDS_OPERATOR', undefined, undefined, 'DISPATCH_FAILED'); summary.needsOperator++; continue;
      }
      // An ACK failure is deliberately not treated as dispatch failure. Replay
      // uses the same event/task/run idempotency keys after the lease expires.
      await this.queue.acknowledge(event.id, claimed.lease, 'DISPATCHED', result.taskId, result.runId, 'REGISTERED'); summary.dispatched++;
    }
    return summary;
  }
}

async function main() {
  const configFile = process.argv[2];
  if (!configFile) throw Error('Pass the local bridge configuration JSON path');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(config.table || '') || !/^[a-z]{2}-[a-z]+-\d$/.test(config.region || '')) throw Error('Invalid bridge configuration');
  // SDK default credential chain reuses the existing named AWS login/profile.
  // Model/provider credentials are never accepted by this bridge.
  const {SystemErrorQueue} = await import('../../../../lib/systemErrors/queue.ts');
  const queue = new SystemErrorQueue({table: config.table, region: config.region, release: 'unknown'});
  if (process.argv.includes('--status')) {
    const page = await queue.list();
    process.stdout.write(JSON.stringify({events:page.events.map(({id,state,attempts,taskId,runId,outcome,leaseUntil})=>({id,state,attempts,taskId,runId,outcome,leaseUntil})),cursor:page.cursor},null,2)+'\n');return;
  }
  const retryIndex = process.argv.indexOf('--retry');
  if (retryIndex >= 0) {await queue.retry(process.argv[retryIndex+1]);process.stdout.write('RETRY_QUEUED\n');return;}
  const base = config.intakeOnly === true ? null : assertLocalOrchestratorUrl(config.orchestratorUrl);
  const operatorToken = base ? fs.readFileSync(config.operatorTokenFile, 'utf8').trim() : '';
  const dashboardToken = base && config.dashboardTokenFile ? fs.readFileSync(config.dashboardTokenFile, 'utf8').trim() : '';
  if (base && operatorToken.length < 32) throw Error('Invalid operator credential');
  const request = async (method, route, body) => {
    if (!base) throw Error('INTAKE_ONLY');
    const response = await fetch(base + route, {method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: {
      'Content-Type':'application/json','X-Bello-Request':'1','X-Bello-Eco-Operator': operatorToken,
      ...(dashboardToken && {'X-Bello-Token':dashboardToken}),
    }, ...(method === 'POST' && {body:JSON.stringify(body)})});
    if (!response.ok) throw Error('ORCHESTRATOR_REQUEST_FAILED');
    return response.json();
  };
  const bridge = new SystemErrorBridge({queue, request, intakeOnly: config.intakeOnly === true});
  const statusFile = path.resolve(config.statusFile || path.join(path.dirname(configFile),'system-error-bridge-status.json'));
  const startedAt = new Date().toISOString(); let lastSuccessAt = null;
  const recordStatus = (state, failures, counts = {}) => {
    const value = {at:new Date().toISOString(),startedAt,pid:process.pid,mode:config.intakeOnly === true ? 'intake-only' : 'bounded-local-repair',
      automaticRepairReady:config.intakeOnly === true ? false : null,state,lastSuccessAt,failures,...counts};
    const temporary = statusFile + `.tmp-${process.pid}`;
    fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,statusFile);
  };
  let stopped = false;
  process.once('SIGINT', () => {stopped = true;}); process.once('SIGTERM', () => {stopped = true;});
  let failures = 0;
  recordStatus('STARTING',failures);
  do {
    try {const status = await bridge.once(); failures = 0; lastSuccessAt = new Date().toISOString();recordStatus(config.intakeOnly === true ? 'INTAKE_ONLY' : 'POLL_SUCCEEDED',failures,status);if (status.dispatched || status.needsOperator || status.verifiedLocal) process.stdout.write(JSON.stringify({at:new Date().toISOString(),...status})+'\n');}
    catch {failures++;recordStatus('RETRYING',failures);process.stderr.write(JSON.stringify({at:new Date().toISOString(),status:'BRIDGE_RETRY',failures})+'\n');}
    if (process.argv.includes('--once') || stopped) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(60000, 15000 * 2 ** Math.min(failures, 2))));
  } while (!stopped);
  if (failures && process.argv.includes('--once')) process.exitCode = 1;
  if (stopped) recordStatus('STOPPED',failures);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {process.stderr.write('BRIDGE_CONFIGURATION_FAILED\n');process.exitCode = 1;});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runService } from '../src/app.mjs';
import { Store } from '../src/store/db.mjs';
import { Repo } from '../src/store/repo.mjs';
import { buildHarness } from './helpers.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'service did not reach expected state');
    await delay(20);
  }
}

test('stop flag drains work and inbox before closing DB and releasing ownership', async () => {
  const h = await buildHarness();
  h.config.intake.pollIntervalSeconds = 0.02;
  let releaseWork, releaseInbox;
  const work = new Promise(resolve => { releaseWork = resolve; });
  const inbox = new Promise(resolve => { releaseInbox = resolve; });
  let started = false, scans = 0;
  h.orchestrator.runLoop = async () => {
    started = true;
    await work;
    h.repo.audit('test', 'work.saved', null, 'saved after stop', null);
  };
  h.intake.scanInbox = async () => {
    scans++;
    await inbox;
    h.repo.audit('test', 'inbox.saved', null, 'saved after stop', null);
  };
  const service = runService({ config: h.config, paths: h.paths, appFactory: async () => h });
  try {
    await until(() => started && scans === 1);
    fs.writeFileSync(h.paths.stopFlag, 'stop');
    await until(() => h.orchestrator.stopping);
    assert.equal(h.orchestrator.stopCurrentRequested, false, 'service stop lets current work finish');
    assert.equal(h.store.integrityCheck().ok, true, 'DB must remain usable');
    assert.equal(fs.existsSync(h.paths.pidFile), true, 'ownership stays held until writes finish');
    assert.equal(scans, 1, 'inbox scans cannot overlap');
    releaseWork();
    await delay(40);
    assert.equal(fs.existsSync(h.paths.pidFile), true, 'inbox is still writing');
    releaseInbox();
    assert.equal(await service, 0);
    assert.equal(fs.existsSync(h.paths.pidFile), false);
    const stored = await Store.open(h.paths.dbFile);
    try {
      const audit = new Repo(stored).listAudit().map(row => row.action);
      assert.ok(audit.includes('work.saved'));
      assert.ok(audit.includes('inbox.saved'));
      assert.equal(audit.filter(action => action === 'orchestrator.stop').length, 1);
    } finally { stored.close(); }
  } finally {
    releaseWork(); releaseInbox();
    await service;
    h.cleanup();
  }
});

test('persisted CLI pause is applied by next tick without restarting service', async () => {
  const h = await buildHarness();
  try {
    h.repo.setPaused(true, 'test');
    await h.orchestrator.tick();
    assert.equal(h.orchestrator.paused, true);
    h.repo.setPaused(false, 'test');
    await h.orchestrator.tick();
    assert.equal(h.orchestrator.paused, false);
    h.orchestrator.stop();
    h.repo.claimNextTask = () => { throw new Error('stopped service must not claim'); };
    assert.equal(await h.orchestrator.tick(), false);
  } finally { h.cleanup(); }
});

test('disabled dashboard CLI explicitly skips HTTP instead of reporting failure', async () => {
  const h = await buildHarness();
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const configPath = path.join(h.paths.dataRoot, 'isolated-config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(h.config));
    for (const command of ['health-check', 'status']) {
      const result = spawnSync(process.execPath, [cli, command, '--json'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, BELLO_ORCHESTRATOR_CONFIG: configPath },
      });
      const data = JSON.parse(result.stdout);
      assert.equal((data.health ?? data).skipped, true);
      assert.equal((data.health ?? data).ok, null);
      if (command === 'health-check') assert.equal(result.status, 0);
      else assert.notEqual(result.status, 0, 'status still detects absent process');
    }
  } finally { h.cleanup(); }
});

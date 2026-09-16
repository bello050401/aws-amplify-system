// One-time correction of the dedicated smoke run's misclassified provider 429.
// The original transition history and Agent stdout are retained.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/store/db.mjs';
import { EcoStore } from '../../src/eco/store.mjs';
const root = 'C:/Users/win/Documents/Codex/bello-eco-live-20260916';
const info = JSON.parse(fs.readFileSync(root + '/run.json', 'utf8'));
const outputs = fs.readdirSync(root + '/data/runs/' + info.taskId).filter(n => n.endsWith('.stdout.log'));
if (outputs.length !== 1) throw Error('Unexpected execution history');
const envelope = JSON.parse(fs.readFileSync(path.join(root, 'data/runs', info.taskId, outputs[0]), 'utf8'));
if (envelope.api_error_status !== 429 || envelope.usage?.input_tokens !== 0 || envelope.usage?.output_tokens !== 0) throw Error('Capacity-only correction not proven');
const store = await Store.open(info.db); const eco = new EcoStore({ store }); const old = eco.get(info.runId);
if (old.state !== 'WAITING_CAPACITY') {
  fs.writeFileSync(root + '/before-capacity-correction.json', JSON.stringify(old, null, 2), { flag: 'wx' });
  eco.mutate(old.id, old.version, 'WAITING_CAPACITY', { repairCount: 0, logicalFailures: 0, pendingEffect: null, providerResetNotice: '2026-09-16 19:00 Asia/Tokyo', counterCorrection: { fromRepairCount: old.repairCount, fromLogicalFailures: old.logicalFailures, reason: 'Provider 429, zero input/output tokens: no implementation attempt ran' } }, 'Correct provider-capacity misclassification; preserve original history and stdout', 'host-correction');
}
fs.writeFileSync(root + '/result.json', JSON.stringify({ run: eco.get(info.runId), delivery: null }, null, 2));
console.log(eco.get(info.runId).state); store.close();

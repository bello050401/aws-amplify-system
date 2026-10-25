import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/retentionCli.mjs';
import { recordSuccessfulEdit } from '../src/retention.mjs';

test('touch mode also cleans the separately installed Lightroom bridge', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-touch-retention-'));
  const bridgeRoot = path.join(root, 'bridge');
  const job = path.join(bridgeRoot, 'lightroom', 'jobs', '11111111-1111-4111-8111-111111111111');
  const previous = process.env.BELLO_LIGHTROOM_BRIDGE_ROOT;
  try {
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, 'photo.jpg'), 'bridge original');
    await writeFile(path.join(job, 'job-retention.json'), JSON.stringify({version:1,expiresAt:'2020-01-08T00:00:00Z',inputName:'photo.jpg'}));
    process.env.BELLO_LIGHTROOM_BRIDGE_ROOT = bridgeRoot;
    assert.equal((await main([path.join(root, 'station'), '[]', 'inspect'])).lightroom.removed.length, 0);
    assert.equal((await main([path.join(root, 'station'), '[]', 'execute'])).lightroom.removed.length, 1);
  } finally {
    if(previous === undefined) delete process.env.BELLO_LIGHTROOM_BRIDGE_ROOT; else process.env.BELLO_LIGHTROOM_BRIDGE_ROOT = previous;
    await rm(root,{recursive:true,force:true});
  }
});

test('期限後も検査モードは削除せず、実行時は完了済み許可セッションだけ消す', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-retention-cli-'));
  const approved = '11111111-1111-4111-8111-111111111111';
  const held = '22222222-2222-4222-8222-222222222222';
  try {
    for (const id of [approved, held]) {
      const folder = path.join(root, 'sessions', id);
      await mkdir(path.join(folder, 'source'), { recursive: true });
      await mkdir(path.join(folder, 'processed'), { recursive: true });
      await writeFile(path.join(folder, 'source', 'photo.arw'), id);
      await writeFile(path.join(folder, 'processed', 'photo.jpg'), id);
      await recordSuccessfulEdit(root, id, 'a'.repeat(64), new Date('2020-01-01'));
    }
    const inspected = await main([root, JSON.stringify([approved]), 'inspect']);
    assert.equal(inspected.expired.length, 2);
    assert.equal(inspected.removed.length, 0);
    assert.equal(await readFile(path.join(root, 'sessions', approved, 'source', 'photo.arw'), 'utf8'), approved);
    const executed = await main([root, JSON.stringify([approved]), 'execute']);
    assert.deepEqual(executed.removed, [{ sessionId: approved, directory: 'source' }]);
    assert.equal(await readFile(path.join(root, 'sessions', held, 'source', 'photo.arw'), 'utf8'), held);
    assert.equal(await readFile(path.join(root, 'sessions', approved, 'processed', 'photo.jpg'), 'utf8'), approved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

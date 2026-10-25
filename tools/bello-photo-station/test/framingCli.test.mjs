import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { main } from '../src/presetCli.mjs';

test('トップ画像とプレビュー承認はセッションへ保存され、再起動後も読める', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-framing-cli-'));
  const session = '1c93496a-50bc-4f04-a1ca-2244f77445db';
  const source = path.join(root, 'sessions', session, 'source');
  await mkdir(source, { recursive: true });
  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#dedede' } })
    .jpeg().toFile(path.join(source, 'top.jpg'));
  const before = await main(['list', root, session]);
  assert.ok(before.presets.some(preset => preset.name === 'BELLO調整用　床も'));
  await main(['top', root, session, 'top.jpg']);
  const fingerprint = 'a'.repeat(64);
  await main(['confirm-framing', root, session, fingerprint]);
  const after = await main(['list', root, session]);
  assert.equal(after.framingChoice.topFileName, 'top.jpg');
  assert.equal(after.framingChoice.confirmedPlanHash, fingerprint);
  await assert.rejects(main(['top', root, session, '../other.jpg']), /見つかりません/);
});

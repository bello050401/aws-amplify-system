import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../src/isMainModule.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
async function aliasDirectory(target) {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-cli-entry-'));
  const alias = path.join(root, '日本語と空白のある テスト用リンク');
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, alias };
}

test('direct module detection resolves a directory junction and still rejects other files', async () => {
  const { alias } = await aliasDirectory(sourceRoot);
  const self = path.join(alias, 'test', 'cliEntry.test.mjs');
  assert.equal(isMainModule(import.meta.url, self), true);
  assert.equal(isMainModule(import.meta.url, path.join(alias, 'src', 'cli.mjs')), false);
  assert.equal(isMainModule(import.meta.url, ''), false);
});

test('preset list started by the desktop through a junction returns RESULT_JSON', async () => {
  const { root, alias } = await aliasDirectory(sourceRoot);
  const station = path.join(root, '試験用データ');
  const session = '11111111-1111-1111-1111-111111111111';
  await mkdir(path.join(station, 'sessions', session, 'source'), { recursive: true });
  const run = spawnSync(process.execPath, [path.join(alias, 'src', 'presetCli.mjs'), 'list', station, session], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split(/\r?\n/).find(line => line.startsWith('RESULT_JSON:'));
  assert.ok(line, 'The CLI exited without returning the desktop response');
  assert.deepEqual(JSON.parse(line.slice(12)).sources, []);
});

test('importing a CLI module does not execute it', async () => {
  const { root, alias } = await aliasDirectory(sourceRoot);
  const file = path.join(root, 'import-only.mjs');
  await writeFile(file, `await import(${JSON.stringify(pathToFileURL(path.join(alias, 'src', 'presetCli.mjs')).href)}); console.log('IMPORT_ONLY');`);
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'IMPORT_ONLY');
});

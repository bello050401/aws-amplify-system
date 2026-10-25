import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanupExpiredSources, cleanupExpiredLightroomCopies, recordSuccessfulEdit, REDO_WINDOW_MS } from '../src/retention.mjs';

const SESSION = '17304359-8a19-44c5-b5c3-e68b75e7fd68';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

test('import expires exactly seven days later despite changed edits; active source is protected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bello-import-retention-'));
  const folder = path.join(root, 'sessions', SESSION);
  try {
    for (const name of ['source', 'comparisons', 'touch-previews']) {
      await mkdir(path.join(folder, name), { recursive: true });
      await writeFile(path.join(folder, name, 'photo.jpg'), 'owned test copy');
    }
    await writeFile(path.join(folder, 'source-retention.json'), JSON.stringify({ version: 1,
      importedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z' }));
    await recordSuccessfulEdit(root, SESSION, FINGERPRINT_A, new Date('2026-10-06'));
    await recordSuccessfulEdit(root, SESSION, FINGERPRINT_B, new Date('2026-10-07'));
    assert.equal((await cleanupExpiredSources(root, { now: new Date('2026-10-07T23:59:59Z'), canDelete: async () => true })).removed.length, 0);
    assert.equal((await cleanupExpiredSources(root, { now: new Date('2026-10-08'), canDelete: async () => false })).removed.length, 0);
    assert.equal((await cleanupExpiredSources(root, { now: new Date('2026-10-08'), canDelete: async () => true })).removed.length, 3);
    assert.equal((await cleanupExpiredSources(root, { now: new Date('2026-10-09'), canDelete: async () => true })).removed.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Lightroom copies expire too; unknown files and unmarked jobs remain untouched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bello-bridge-retention-'));
  const job = path.join(root, 'lightroom', 'jobs', SESSION);
  try {
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, 'photo.arw'), 'raw');
    await writeFile(path.join(job, 'render.jpg'), 'render');
    await writeFile(path.join(job, 'keep.txt'), 'audit');
    await writeFile(path.join(job, 'job-retention.json'), JSON.stringify({ version: 1, expiresAt: '2026-10-08T00:00:00Z', inputName: 'photo.arw' }));
    assert.equal((await cleanupExpiredLightroomCopies(root, { now: new Date('2026-10-07'), execute: true })).removed.length, 0);
    assert.equal((await cleanupExpiredLightroomCopies(root, { now: new Date('2026-10-08') })).removed.length, 0);
    assert.equal((await cleanupExpiredLightroomCopies(root, { now: new Date('2026-10-08'), execute: true })).removed.length, 2);
    assert.equal(await readFile(path.join(job, 'keep.txt'), 'utf8'), 'audit');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('successful changed edit extends seven days; same-version retry does not', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bello-retention-'));
  try {
    const first = new Date('2026-09-01T00:00:00Z');
    await recordSuccessfulEdit(root, SESSION, FINGERPRINT_A, first);
    await recordSuccessfulEdit(root, SESSION, FINGERPRINT_A, new Date('2026-09-05T00:00:00Z'));
    let marker = JSON.parse(await readFile(path.join(root, 'sessions', SESSION, 'retention.json')));
    assert.equal(marker.lastSuccessfulEditAt, first.toISOString());
    await recordSuccessfulEdit(root, SESSION, FINGERPRINT_B, new Date('2026-09-05T00:00:00Z'));
    marker = JSON.parse(await readFile(path.join(root, 'sessions', SESSION, 'retention.json')));
    assert.equal(marker.lastSuccessfulEditAt, '2026-09-05T00:00:00.000Z');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only marked expired sessions lose temporary photos; history and outside files remain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bello-retention-'));
  const folder = path.join(root, 'sessions', SESSION);
  const now = new Date('2026-09-10T00:00:00Z');
  try {
    await mkdir(path.join(folder, 'source'), { recursive: true });
    await mkdir(path.join(folder, 'processed'), { recursive: true });
    await mkdir(path.join(folder, 'thumbnails'), { recursive: true });
    await writeFile(path.join(folder, 'source', 'raw.arw'), 'raw');
    await writeFile(path.join(folder, 'processed', '001.jpg'), 'published');
    await writeFile(path.join(folder, 'thumbnails', '001.jpg'), 'thumbnail');
    await writeFile(path.join(folder, 'selections.json'), '{}');
    await writeFile(path.join(root, 'history.json'), '{}');
    await recordSuccessfulEdit(root, SESSION, FINGERPRINT_A, new Date(now.getTime() - REDO_WINDOW_MS + 1000));
    assert.deepEqual((await cleanupExpiredSources(root, { now, canDelete: async () => true })).removed, []);
    assert.deepEqual((await cleanupExpiredSources(root, { now })).removed, []); // unknown state fails closed
    const result = await cleanupExpiredSources(root, { now: new Date(now.getTime() + 2000), canDelete: async () => true });
    assert.deepEqual(result.removed, [{ sessionId: SESSION, directory: 'source' }]);
    assert.equal(await readFile(path.join(folder, 'selections.json'), 'utf8'), '{}');
    assert.equal(await readFile(path.join(root, 'history.json'), 'utf8'), '{}');
    assert.equal(await readFile(path.join(folder, 'processed', '001.jpg'), 'utf8'), 'published');
    assert.equal(await readFile(path.join(folder, 'thumbnails', '001.jpg'), 'utf8'), 'thumbnail');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unmarked sessions and symlinked photo directories are never removed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bello-retention-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'bello-outside-'));
  const folder = path.join(root, 'sessions', SESSION);
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(outside, 'keep.arw'), 'keep');
    await symlink(outside, path.join(folder, 'source'), 'junction');
    assert.deepEqual((await cleanupExpiredSources(root, { now: new Date('2026-09-20'), canDelete: async () => true })).removed, []);
    await recordSuccessfulEdit(root, SESSION, FINGERPRINT_A, new Date('2026-09-01'));
    assert.deepEqual((await cleanupExpiredSources(root, { now: new Date('2026-09-20'), canDelete: async () => true })).removed, []);
    assert.equal(await readFile(path.join(outside, 'keep.arw'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

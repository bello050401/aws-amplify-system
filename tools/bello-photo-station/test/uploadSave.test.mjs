import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadSavedPhotos } from '../src/uploadSave.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-save-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processedPath = path.join(root, 'p.jpg'), thumbnailPath = path.join(root, 't.jpg');
  await writeFile(processedPath, 'photo'); await writeFile(thumbnailPath, 'thumb');
  const sessions = [], saved = new Map(); let deleted = false, offline = false;
  const api = { upload: async () => {}, call: async (op, input) => {
    if (op === 'createPhotoBatch') {
      sessions.push(input.localImportSessionId);
      if (!saved.has(input.localImportSessionId)) saved.set(input.localImportSessionId, { ready: false });
      return { batchId: input.localImportSessionId, batchCode: 'PB', status: 'CREATED' };
    }
    if (op === 'requestPhotoAssetUploads') {
      if (deleted && input.batchId === sessions[0]) throw Object.assign(new Error('clientAssetId 007 refers to a deleted asset; use restore or a new clientAssetId'), { code: 'IDEMPOTENCY_CONFLICT' });
      if (offline) throw Object.assign(new Error('network uncertain'), { code: 'HTTP_ERROR' });
      return { items: input.assets.map(a => ({ clientAssetId: a.clientAssetId,
        photoAssetId: input.batchId + a.clientAssetId, kind: saved.get(input.batchId).ready ? 'ALREADY_READY' : 'CREATE_ASSET', uploads: [] })) };
    }
    if (op === 'completePhotoBatch') { saved.get(input.batchId).ready = true; return { batchId: input.batchId, status: 'READY_FOR_REVIEW' }; }
    return { status: 'READY' };
  } };
  return { sessions, saved, setDeleted: () => { deleted = true; }, setOffline: v => { offline = v; },
    input: { api, stateFile: path.join(root, 'save.json'), sessionId: 'sd-import', deviceId: 'test',
      assets: [{ clientAssetId: '007', fileName: 'photo.jpg', processedPath, thumbnailPath }] } };
}

test('same explicit save and retry use one durable batch; checkpoints retain the local import identity', async t => {
  const f = await fixture(t), checkpoints = [];
  const input = { ...f.input, onCheckpoint: c => checkpoints.push(c) };
  const first = await uploadSavedPhotos(input), second = await uploadSavedPhotos(input);
  assert.equal(first.batchId, second.batchId); assert.equal(f.saved.size, 1);
  assert.ok(checkpoints.every(c => c.sessionId === 'sd-import'));
  assert.equal(checkpoints.filter(c => c.phase === 'ASSET_READY').length, 2);
});

test('deleted 007 uses a new saved batch once, without restoring deleted records; restart resumes it', async t => {
  const f = await fixture(t);
  const first = await uploadSavedPhotos(f.input); f.setDeleted();
  const second = await uploadSavedPhotos(f.input);
  assert.notEqual(first.batchId, second.batchId); assert.equal(f.saved.size, 2);
  assert.equal((await uploadSavedPhotos(f.input)).batchId, second.batchId);
  assert.equal(f.saved.size, 2);
  assert.equal(JSON.parse(await readFile(f.input.stateFile, 'utf8')).uploadSessionId, second.batchId);
});

test('ambiguous network error never rotates identity and can be resumed after restart', async t => {
  const f = await fixture(t); f.setOffline(true);
  await assert.rejects(uploadSavedPhotos(f.input), /network uncertain/);
  const pending = JSON.parse(await readFile(f.input.stateFile, 'utf8')).uploadSessionId;
  f.setOffline(false);
  assert.equal((await uploadSavedPhotos(f.input)).batchId, pending); assert.equal(f.saved.size, 1);
});

test('changed processed photo gets a distinct revision, identical edited retry does not duplicate', async t => {
  const f = await fixture(t); const first = await uploadSavedPhotos(f.input);
  await writeFile(f.input.assets[0].processedPath, 'new crop');
  const next = await uploadSavedPhotos(f.input);
  assert.notEqual(next.batchId, first.batchId);
  assert.equal((await uploadSavedPhotos(f.input)).batchId, next.batchId); assert.equal(f.saved.size, 2);
});

test('failure after replacing deleted identity retains the new identity for the next attempt', async t => {
  const f = await fixture(t); await uploadSavedPhotos(f.input); f.setDeleted(); f.setOffline(true);
  await assert.rejects(uploadSavedPhotos(f.input), /network uncertain/);
  const pending = JSON.parse(await readFile(f.input.stateFile, 'utf8')).uploadSessionId;
  assert.notEqual(pending, f.sessions[0]); f.setOffline(false);
  assert.equal((await uploadSavedPhotos(f.input)).batchId, pending); assert.equal(f.saved.size, 2);
});

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeFile, uploadSession } from './client.mjs';

// A saved edit is distinct from an SD import. Persist its identity BEFORE any
// request, so a timeout/restart resumes the same batch instead of duplicating it.
export async function uploadSavedPhotos({ stateFile, ...input }) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const lockPath = `${stateFile}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await readFile(lockPath, 'utf8'));
    let alive = Number.isInteger(owner) && owner > 0;
    if (alive) {
      try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    }
    if (alive || !owner) throw new Error('写真の保存を実行中です。完了してからもう一度お試しください。');
    await unlink(lockPath);
    lock = await open(lockPath, 'wx');
  }
  try {
    await lock.writeFile(String(process.pid));
    const assets = [];
    for (const a of input.assets) assets.push({ id: a.clientAssetId, name: a.fileName,
      processed: await describeFile(a.processedPath), thumbnail: await describeFile(a.thumbnailPath) });
    const fingerprint = createHash('sha256').update(JSON.stringify({
      sessionId: input.sessionId, deviceId: input.deviceId, assets,
    })).digest('hex');
    let state;
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const persist = async () => {
      const temporary = `${stateFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
      await rename(temporary, stateFile);
    };
    if (state?.fingerprint !== fingerprint || !state.uploadSessionId) {
      state = { version: 1, fingerprint, sourceSessionId: input.sessionId,
        uploadSessionId: `ps-save-${fingerprint}`, createdAt: new Date().toISOString() };
      await persist();
    }
    const send = () => uploadSession({ ...input, sessionId: state.uploadSessionId,
      onCheckpoint: c => input.onCheckpoint?.({ ...c, sessionId: input.sessionId }) });
    try { return await send(); }
    catch (error) {
      // An explicit save after deletion is a new save, never a restoration of
      // the deleted asset. Do not rotate identities for network/permission or
      // ordinary conflict errors: the outcome might already be committed.
      const deleted = error.code === 'IDEMPOTENCY_CONFLICT' &&
        /^clientAssetId .+ refers to a deleted asset; use restore or a new clientAssetId$/.test(error.message);
      const archived = error.code === 'INVALID_STATUS_TRANSITION' && /ARCHIVED batch/.test(error.message);
      if (!deleted && !archived) throw error;
      state = { ...state, uploadSessionId: `ps-save-${randomUUID()}`,
        replacedDeletedSaveAt: new Date().toISOString() };
      await persist();
      return await send();
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

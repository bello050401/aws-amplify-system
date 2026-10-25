import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const REDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/i;
// Only the local originals and disposable comparison previews expire. The
// processed images and thumbnails are part of the successful upload history
// and must remain available for audit and safe retry.
const TEMP_DIRS = ['source', 'comparisons', 'touch-previews'];

function sessionPath(root, sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error('セッションIDが無効です');
  return path.join(root, 'sessions', sessionId);
}

export function expiresAtMs(lastSuccessfulEditAt) {
  const started = Date.parse(lastSuccessfulEditAt);
  if (!Number.isFinite(started)) throw new Error('保存期限の日時が無効です');
  return started + REDO_WINDOW_MS;
}

export async function readSourceExpiry(folder) {
  let marker;
  try { marker = JSON.parse(await readFile(path.join(folder, 'source-retention.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const imported = Date.parse(marker.importedAt), expires = Date.parse(marker.expiresAt);
  if (marker.version !== 1 || !Number.isFinite(imported) || expires !== imported + REDO_WINDOW_MS)
    throw new Error('取込原本の保管期限が無効です');
  return expires;
}

/** Record edit history. The import's source-retention.json deadline is immutable. */
export async function recordSuccessfulEdit(root, sessionId, fingerprint, now = new Date()) {
  if (!FINGERPRINT.test(fingerprint)) throw new Error('編集の指紋が無効です');
  const folder = sessionPath(root, sessionId);
  const marker = path.join(folder, 'retention.json');
  let previous = null;
  try { previous = JSON.parse(await readFile(marker, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.fingerprint === fingerprint) return previous;
  if (!Number.isFinite(now.getTime())) throw new Error('日時が無効です');
  const previousTime = previous?.lastSuccessfulEditAt ? Date.parse(previous.lastSuccessfulEditAt) : 0;
  const value = { version: 1, fingerprint: fingerprint.toLowerCase(), lastSuccessfulEditAt: new Date(Math.max(now.getTime(), Number.isFinite(previousTime) ? previousTime : 0)).toISOString() };
  await mkdir(folder, { recursive: true });
  const temporary = `${marker}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, marker);
  return value;
}

async function isPlainDirectory(folder) {
  try { return (await lstat(folder)).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/**
 * Deletes only allowlisted temporary directories in marked sessions.
 * The caller must confirm that no upload/redo is in progress via canDelete.
 * Legacy sessions without a marker are deliberately untouched.
 */
export async function cleanupExpiredSources(root, { now = new Date(), canDelete = async () => false } = {}) {
  const sessions = path.join(root, 'sessions');
  if (!await isPlainDirectory(sessions)) return { expired: [], removed: [], skipped: [] };
  const sessionsReal = await realpath(sessions);
  const result = { expired: [], removed: [], skipped: [] };
  for (const entry of await readdir(sessions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const folder = sessionPath(root, entry.name);
    if (path.dirname(await realpath(folder)) !== sessionsReal) continue;
    let expiry;
    try { expiry = await readSourceExpiry(folder); }
    catch { result.skipped.push({ sessionId: entry.name, reason: 'invalid-import-marker' }); continue; }
    let marker;
    if (expiry === null) {
    try { marker = JSON.parse(await readFile(path.join(folder, 'retention.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; result.skipped.push({ sessionId: entry.name, reason: 'invalid-marker' }); continue; }
    if (marker?.version !== 1 || !FINGERPRINT.test(marker.fingerprint ?? '')) {
      result.skipped.push({ sessionId: entry.name, reason: 'invalid-marker' }); continue;
    }
    try { expiry = expiresAtMs(marker.lastSuccessfulEditAt); }
    catch { result.skipped.push({ sessionId: entry.name, reason: 'invalid-marker' }); continue; }
    }
    if (now.getTime() < expiry) continue;
    result.expired.push(entry.name);
    if (!await canDelete(entry.name)) { result.skipped.push({ sessionId: entry.name, reason: 'active-or-unknown' }); continue; }
    for (const name of TEMP_DIRS) {
      const target = path.join(folder, name);
      // Refuse symlink/junction targets, including a changed session root.
      if (!await isPlainDirectory(folder) || !await isPlainDirectory(target)) continue;
      if (path.dirname(await realpath(target)) !== await realpath(folder)) continue;
      await rm(target, { recursive: true, force: false });
      result.removed.push({ sessionId: entry.name, directory: name });
    }
  }
  return result;
}

/** Lightroom job copies are disposable, bounded jobs (minutes, never days).
 * Only the two known image files in UUID job directories are removed. */
export async function cleanupExpiredLightroomCopies(root, { now = new Date(), execute = false } = {}) {
  const jobs = path.join(root, 'lightroom', 'jobs');
  const result = { expired: [], removed: [], skipped: [] };
  if (!await isPlainDirectory(jobs)) return result;
  const jobsReal = await realpath(jobs);
  for (const entry of await readdir(jobs, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const folder = path.join(jobs, entry.name);
    if (path.dirname(await realpath(folder)) !== jobsReal) continue;
    let marker;
    try { marker = JSON.parse(await readFile(path.join(folder, 'job-retention.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') result.skipped.push(entry.name); continue; }
    if (marker.version !== 1 || !Number.isFinite(Date.parse(marker.expiresAt)) || typeof marker.inputName !== 'string'
      || path.basename(marker.inputName) !== marker.inputName || !/\.(jpg|jpeg|arw)$/i.test(marker.inputName)) { result.skipped.push(entry.name); continue; }
    if (now.getTime() < Date.parse(marker.expiresAt)) continue;
    result.expired.push(entry.name);
    if (!execute) continue;
    for (const name of new Set([marker.inputName, 'render.jpg'])) {
      const target = path.join(folder, name);
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || path.dirname(await realpath(target)) !== await realpath(folder)) continue;
        await rm(target);
        result.removed.push({ jobId: entry.name, file: name });
      } catch (error) { if (error.code !== 'ENOENT') result.skipped.push(entry.name); }
    }
  }
  return result;
}

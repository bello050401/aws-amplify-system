import path from 'node:path';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { sha256File } from './processImage.mjs';

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function validateExportDirectory(directory, protectedRoots = []) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('保存先フォルダーを選択してください');
  // Do not create a missing mapped drive or share locally after it disconnects.
  const target = await realpath(directory);
  if (!(await lstat(target)).isDirectory()) throw new Error('保存先がフォルダーではありません');
  for (const root of protectedRoots.filter(Boolean)) {
    let resolved;
    try { resolved = await realpath(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (contained(resolved, target)) throw new Error('原本・アプリ・作業用フォルダーの外を保存先に選んでください');
  }
  return target;
}

// Each completed product is published as a whole directory. Existing exports
// are only reused after hash verification; user edits are never overwritten.
export async function exportLocalPhotos({ sessionId, assets, directory, protectedRoots = [] }) {
  const target = await validateExportDirectory(directory, protectedRoots);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId) || assets.length === 0) throw new Error('保存する写真がありません');
  const files = [];
  for (const [index, asset] of assets.entries()) {
    const stem = path.parse(path.basename(asset.fileName)).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 65) || 'photo';
    const fileName = `${String(index + 1).padStart(3, '0')}-${stem}.jpg`;
    files.push({ fileName, originalName: asset.fileName, sha256: await sha256File(asset.processedPath),
      thumbnailSha256: await sha256File(asset.thumbnailPath) });
  }
  const manifest = { version: 1, sessionId, files };
  const json = JSON.stringify(manifest, null, 2);
  const key = createHash('sha256').update(json).digest('hex').slice(0, 16);
  const destination = path.join(target, `BELLO-${sessionId}-${key}`);
  async function verifyExisting() {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('保存先にリンクがあります');
    if (await readFile(path.join(destination, '保存内容.json'), 'utf8') !== json) throw new Error('同名の保存先が変更されています。別のフォルダーを選んでください');
    for (const file of files) {
      for (const [relative, hash] of [[file.fileName, file.sha256], [path.join('サムネイル', file.fileName), file.thumbnailSha256]]) {
        const full = path.join(destination, relative);
        if ((await lstat(full)).isSymbolicLink() || await sha256File(full) !== hash)
          throw new Error('保存済みの写真が変更されています。上書きせず停止しました');
      }
    }
    return { savedDirectory: destination, saved: files };
  }
  let exists = false;
  try { await lstat(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) return await verifyExisting();
  const temporary = await mkdtemp(path.join(target, '._BELLO-saving-'));
  try {
    await mkdir(path.join(temporary, 'サムネイル'));
    for (const [index, file] of files.entries()) {
      for (const [source, relative, hash] of [[assets[index].processedPath, file.fileName, file.sha256],
        [assets[index].thumbnailPath, path.join('サムネイル', file.fileName), file.thumbnailSha256]]) {
        const output = path.join(temporary, relative);
        await copyFile(source, output, constants.COPYFILE_EXCL);
        if (await sha256File(output) !== hash) throw new Error('保存した写真の照合に失敗しました');
      }
    }
    await writeFile(path.join(temporary, '保存内容.json'), json, { flag: 'wx' });
    try { await rename(temporary, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      return await verifyExisting();
    }
    return { savedDirectory: destination, saved: files };
  } finally {
    // Only our newly-created temporary directory, never the selected folder.
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

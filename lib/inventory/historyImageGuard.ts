import {HeadObjectCommand, S3Client} from '@aws-sdk/client-s3';

/** Check only object references already recorded in inventory history. Never
 * fetch a caller-supplied URL or another bucket while restoring an image. */
export async function verifyHistoryImageObjects(
  client: Pick<S3Client, 'send'>,
  bucket: string,
  before: unknown,
  after: unknown,
) {
  if (!Array.isArray(after)) return;
  const current = new Set(Array.isArray(before) ? before.map(image => image?.storageKey) : []);
  const keys = [...new Set(after.map(image => image?.storageKey).filter(key => typeof key === 'string' && !current.has(key)))] as string[];
  for (let at = 0; at < keys.length; at += 4) {
    await Promise.all(keys.slice(at, at + 4).map(async key => {
      if (!key.startsWith('inventory/') || key.includes('..') || !bucket)
        throw Error('履歴の画像参照を確認できません。画像は変更していません。');
      try { await client.send(new HeadObjectCommand({Bucket: bucket, Key: key})); }
      catch { throw Error('復元する画像が取得できません。画像が削除されていないか確認してください。'); }
    }));
  }
}

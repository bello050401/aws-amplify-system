import { imagePath } from './imagePath.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { main, isUsableValidationToken } from './cli.mjs';

const API = 'https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com/';
const DEVICE = 'BELLO-PHOTO-PC-01';

export async function createSyntheticValidationPhoto(filePath) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
    <rect width="600" height="400" fill="#eeeeea"/>
    <path d="M0 263 H600" stroke="#555" stroke-width="4"/>
    <rect y="265" width="600" height="135" fill="#d7d4cd"/>
    <rect x="226" y="124" width="146" height="105" rx="12" fill="#6b594e"/>
    <path d="M235 224 H363 L385 275 H213 Z" fill="#544238"/>
    <path d="M233 274 L220 343 M363 274 L377 343" stroke="#292421" stroke-width="12"/>
    <text x="16" y="380" font-size="20" fill="#772222">BELLO SYNTHETIC VALIDATION ONLY</text>
  </svg>`);
  await sharp(svg).jpeg({ quality: 78 }).toFile(imagePath(filePath));
}

export async function runValidationSmoke(root) {
  if (!isUsableValidationToken(process.env.BELLO_PHOTO_STATION_TOKEN)) {
    throw new Error('Validation PHOTO_DEVICE token is missing or expired');
  }
  const sessionId = randomUUID();
  const sessionRoot = path.join(root, 'sessions', sessionId);
  const sourceDir = path.join(sessionRoot, 'source');
  await mkdir(sourceDir, { recursive: true });
  await createSyntheticValidationPhoto(path.join(sourceDir, 'BELLO_SYNTHETIC_TEST.jpg'));
  const result = await main([
    '--session-id', sessionId,
    '--source-dir', sourceDir,
    '--output-root', sessionRoot,
    '--settings-file', path.join(root, 'settings.json'),
    '--history-file', path.join(root, 'history.json'),
    '--device-id', DEVICE,
    '--api-endpoint', API,
  ]);
  const receipt = {
    sessionId,
    status: result.status,
    batchId: result.batchId ?? null,
    batchCode: result.batchCode ?? null,
    uploadedCount: result.uploaded?.length ?? 0,
    syntheticOnly: true,
    at: new Date().toISOString(),
  };
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  if (result.status !== 'COMPLETE') throw new Error('Validation upload did not complete; see local receipt');
  return receipt;
}

if ((await import('./isMainModule.mjs')).isMainModule(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error('Validation output root is required');
  runValidationSmoke(root)
    .then(r => console.log(`VALIDATION_RECEIPT:${JSON.stringify(r)}`))
    .catch(error => { console.error('検証専用アップロード失敗：' + error.message); process.exitCode = 1; });
}

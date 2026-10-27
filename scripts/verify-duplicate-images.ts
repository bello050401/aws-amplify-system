import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { buildDuplicateImages, isPhotoProcessedCopyKey } from '../lib/inventory/duplicateImages';
import { normalizeImageRecord } from '../lib/inventory/imageTypes';
import type { WebPhotoAssetView } from '../lib/photoRegistration/webAdapter';

const asset = (id: string, extra = {}) => ({ id, photoBatchId: 'batch', sequence: 0, status: 'READY', isDeleted: false,
  declared: { PROCESSED: { mimeType: 'image/jpeg', sha256: 'original-bytes-hash' } },
  thumbnailUrl: `https://photo.example/${id}-thumb.jpg`, processedUrl: `https://photo.example/${id}.jpg`, ...extra,
} as WebPhotoAssetView);
const legacy = normalizeImageRecord({ storageKey: 'inventory/legacy.jpg', sortOrder: 0, isPrimary: true, thumbnailKey: 'inventory/legacy-small.jpg' });

async function main() {
  assert.ok(isPhotoProcessedCopyKey('photo-batches/batch/processed/batch#A#asset.jpg'));
  assert.ok(isPhotoProcessedCopyKey('photo-batches/batch/processed/legacy.webp'));
  for (const key of ['photo-batches/batch/originals/batch#A#asset.jpg', 'photo-batches/batch/processed/other#A#asset.jpg', 'photo-batches/../processed/x.jpg', 'photo-batches/batch/processed/x.jpg/../secret']) assert.equal(isPhotoProcessedCopyKey(key), false);
  const sources = [asset('second', { sequence: 1 }), asset('top', { inventoryIsPrimary: true }), asset('damage', { inventoryImageType: 'DAMAGE' }),
    asset('deleted', { isDeleted: true }), asset('pending', { status: 'UPLOADING' }), asset('purged', { purgedAt: '2026-10-27' })];
  const before = JSON.stringify(sources);
  const result = buildDuplicateImages([legacy], sources, 'photo-bucket');
  assert.equal(result.normal.length, 3); assert.equal(result.damage.length, 1);
  assert.equal(result.normal[0].storageKey, 'photo-batches/batch/processed/top.jpg');
  assert.equal(result.normal.filter(image => image.isPrimary).length, 1);
  assert.ok(result.damage.every(image => !image.isPrimary));
  assert.equal(result.normal[0].sourceBucket, 'photo-bucket');
  assert.equal(result.normal[0].thumbnailKey, null);
  assert.equal(result.previewUrls[result.normal[0].storageKey], 'https://photo.example/top.jpg');
  assert.equal(JSON.stringify(sources), before);
  assert.equal(buildDuplicateImages([legacy], [asset('other')], 'photo-bucket').normal[0].storageKey, legacy.storageKey);
  assert.equal(buildDuplicateImages([], [asset('photo-only')], 'photo-bucket').normal.length, 1);
  assert.throws(() => buildDuplicateImages([], [asset('missing-bucket')]), /保存先/);
  assert.equal(buildDuplicateImages([legacy], []).normal[0].storageKey, legacy.storageKey);

  // Exercise the actual create action, replacing only I/O boundaries. Nothing reaches production.
  const files = new Map<string, string>(result.normal.concat(result.damage).flatMap(image => [
    [image.storageKey, `bytes:${image.storageKey}`], ...(image.thumbnailKey ? [[image.thumbnailKey, 'thumbnail']] : []),
  ]) as [string, string][]);
  let writes: any[] = [], failAt = 0, copies = 0, role = 'ADMIN';
  const removed: string[] = [];
  const ports = {
    role: () => role,
    persist: async (input: any) => { writes.push(structuredClone(input)); return { id: 'duplicate' }; },
    copy: async (key: string, bucket?: string) => {
      copies++; if (failAt && copies === failAt) throw Error('simulated copy failure');
      assert.equal(bucket, key.startsWith('photo-batches/') ? 'photo-bucket' : undefined);
      assert.ok(files.has(key)); const dest = `inventory/copy-${copies}.jpg`; files.set(dest, files.get(key)!); return dest;
    },
    remove: async (key: string) => { removed.push(key); files.delete(key); },
    derivatives: async (key: string) => { const small = `${key}-small`, medium = `${key}-medium`; files.set(small, 'small'); files.set(medium, 'medium'); return { thumbnailKey: small, mediumKey: medium }; },
  };
  const stubs: Record<string, string> = {
    'server-only': '',
    '@/lib/inventory/categoryPersistence': 'export const persistInventoryWithCategories=x=>ports.persist(x); export const deleteInventoryWithCategories=()=>{};',
    'next/cache': 'export const revalidatePath=()=>{};',
    'next/navigation': 'export const redirect=()=>{};',
    '@/lib/inventory/inventoryPage': 'export const clearInventoryCountCache=()=>{};',
    '@/lib/amplify/dataClient': 'export const inventoryAuthMode={}; export const serverDataClient={mutations:{generateInventorySku:async()=>({data:"TEST-COPY"})}};',
    '@/lib/amplify/requireInventoryUser': 'export const getInventoryRole=async()=>ports.role(),canEditInventory=r=>r==="ADMIN"||r==="EDITOR",canHardDeleteInventory=r=>r==="ADMIN",getCurrentInventoryUserEmail=async()=>"test";',
    '@/lib/inventory/queries': 'export const getInventoryDetail=()=>{},getInventoryHistory=()=>{},listCategories=()=>[],listLocations=()=>[],listStatuses=()=>[];',
    '@/lib/inventory/imageServerOps': 'export const copyInventoryImage=(...x)=>ports.copy(...x),removeInventoryImage=k=>ports.remove(k),computeOriginalHashForPath=()=>"hash";',
    '@/lib/inventory/thumbnail': 'export const copyInventoryThumbnail=k=>ports.copy(k),copyInventoryMedium=k=>ports.copy(k),generateInventoryDerivatives=k=>ports.derivatives(k),generateInventoryThumbnail=async k=>(await ports.derivatives(k)).thumbnailKey,generateInventoryMedium=async k=>(await ports.derivatives(k)).mediumKey;',
    '@/lib/inventory/history': 'export const logInventoryHistory=async()=>{},diffField=()=>{};',
  };
  const bundled = await build({ entryPoints: ['app/actions/inventory.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'isolated-copy', setup(b) {
    b.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
  }}] });
  const module = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, console, Date, process, require: createRequire(import.meta.url) });
  const input = { name: '複製確認', quantity: 2, images: result.normal.concat(result.damage).map(image => ({
    kind: 'copy', sourceStorageKey: image.storageKey, sourceBucket: image.sourceBucket,
    type: image.type, sortOrder: image.sortOrder, isPrimary: image.isPrimary,
    sourceThumbnailKey: image.thumbnailKey, sourceMediumKey: image.mediumKey,
    sourceOriginalHash: image.originalHash, sourceClassification: image.classification, sourceSystem: null, sourceUrl: null,
  })) };
  await module.exports.createInventory(input, { skipRedirect: true });
  assert.equal(writes.length, 1); assert.equal(writes[0].images.length, 4);
  for (const image of writes[0].images) {
    assert.ok(files.has(image.storageKey)); assert.ok(files.has(image.thumbnailKey)); assert.ok(files.has(image.mediumKey));
    assert.ok(!input.images.some(source => source.sourceStorageKey === image.storageKey)); assert.equal(image.sourceBucket, undefined);
  }
  // Deleting one owned copy never removes the original source bytes.
  await ports.remove(writes[0].images[0].storageKey);
  assert.ok(input.images.every(image => files.has(image.sourceStorageKey)));
  const priorKeys = new Set(files.keys()); writes = []; failAt = copies + 3;
  await assert.rejects(module.exports.createInventory(input, { skipRedirect: true }), /simulated copy failure/);
  assert.equal(writes.length, 0); assert.deepEqual(new Set(files.keys()), priorKeys);
  role = 'VIEWER'; const previousCopies = copies;
  await assert.rejects(module.exports.createInventory(input, { skipRedirect: true }), /権限/);
  assert.equal(copies, previousCopies);
  console.log('PASS: mixed/PhotoStation-only/legacy photos, top + damage + order, preview, independent saved copies, rollback and VIEWER denial.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const sdk = require('@aws-sdk/lib-dynamodb');
function load(path, imports, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    assert.ok(Object.hasOwn(imports, name), name);
    return imports[name];
  }, Buffer, Date, Set, Map, URL, Error, Uint8Array, setTimeout, clearTimeout, AbortController, ...globals });
  return exports;
}
const categoriesModule = load('../categories.ts', {});
const imageTypes = load('../imageTypes.ts', {});
const policy = load('./policy.ts', { '../categories': categoriesModule, '../imageTypes': imageTypes });
const grantsModule = load('./grants.ts', { 'server-only': {}, 'node:crypto': crypto, '@aws-sdk/lib-dynamodb': sdk, './policy': policy });
const serviceModule = load('./service.ts', { 'server-only': {}, './grants': grantsModule, './policy': policy });
const tableKey = (table, key) => JSON.stringify([table, key.scope, key.id]);
class MemoryDb {
  data = new Map();
  calls = [];
  async send(command) {
    this.calls.push(command);
    const input = command.input;
    if (command instanceof sdk.GetCommand) return { Item: this.data.get(tableKey(input.TableName, input.Key)) };
    if (command instanceof sdk.QueryCommand) return { Items: [...this.data.values()].filter(row => row.scope === input.ExpressionAttributeValues[':scope'] && row.id.startsWith(input.ExpressionAttributeValues[':prefix'])) };
    if (command instanceof sdk.TransactWriteCommand) {
      // Existing IAM allows only PutItem in the control namespace.
      assert.ok(input.TransactItems.every(operation => Object.keys(operation).join() === 'Put'));
      for (const { Put } of input.TransactItems) {
        assert.equal(Put.Item.scope, 'control');
        assert.ok(Put.Item.id.startsWith('partner-catalog:'));
        const before = this.data.get(tableKey(Put.TableName, Put.Item));
        const conflict = Put.ConditionExpression === 'attribute_not_exists(id)' ? !!before
          : Put.ConditionExpression === 'revision = :revision' ? before?.revision !== Put.ExpressionAttributeValues[':revision'] : false;
        if (conflict) { const error = new Error('conflict'); error.name = 'TransactionCanceledException'; throw error; }
      }
      for (const { Put } of input.TransactItems) this.data.set(tableKey(Put.TableName, Put.Item), structuredClone(Put.Item));
      return {};
    }
    throw new Error('Unexpected command: ' + command.constructor.name);
  }
}
const masters = [
  { id: 'repair', name: '補修待ち' }, { id: 'photo', name: '撮影待ち' }, { id: 'listing', name: '出品待ち' },
  { id: 'sold', name: '売り切れ' }, { id: 'hold', name: '保留' }, { id: 'igarashi', name: '五十嵐' },
];
const cats = () => policy.catalogCategories(masters);
const baseRow = () => ({ id: 'item-1', sku: 'BELLO-001', name: '【仕入先秘密・在庫2】ラウンジチェア', quantity: 2,
  categoryIds: ['repair'], updatedAt: '2026-11-20T12:00:00.000Z', width: '60', depth: '約55', height: '取引先秘密',
  images: [
    { storageKey: 'inventory/detail.jpg', sortOrder: 0, thumbnailKey: 'inventory/thumbnails/detail.jpg' },
    { storageKey: 'inventory/top.jpg', sortOrder: 1, mediumKey: 'inventory/medium/top.webp', isPrimary: true },
    { storageKey: 'inventory/damage.jpg', sortOrder: 2, type: 'DAMAGE', isPrimary: true },
  ],
  purchasePrice: 12345678, salePrice: 88888888, note: 'PRIVATE_NOTE', adminMemo: 'PRIVATE_ADMIN', counterpartyName: 'PRIVATE_PERSON',
  counterpartyAddress: 'PRIVATE_ADDRESS', customFields: '{"credential":"PRIVATE_CREDENTIAL"}' });

test('grants have 256-bit random capabilities, rotate atomically, expire and disable with allowed IAM operations', async () => {
  let now = Date.parse('2026-11-20T00:00:00Z');
  const db = new MemoryDb();
  const store = grantsModule.createCatalogGrantStore(db, 'metadata', () => now);
  assert.equal(await store.authorize('bad'), null);
  const created = await store.manage({ action: 'create', label: '取引先A' }, 'admin-sub');
  const first = created.path.split('/').at(-1);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
  assert.equal(created.expiresAt, '2027-02-18T00:00:00.000Z');
  assert.equal((await store.authorize(first)).grantId, created.id);
  assert.equal((await store.list()).length, 1);
  const renewed = await store.manage({ action: 'renew', id: created.id, expiresInDays: 1 }, 'another-admin');
  const second = renewed.path.split('/').at(-1);
  assert.equal(renewed.id, created.id);
  assert.notEqual(first, second);
  assert.equal(await store.authorize(first), null);
  assert.ok(await store.authorize(second));
  now += 86400000;
  assert.equal(await store.authorize(second), null, 'expiry boundary denies access');
  const again = await store.manage({ action: 'renew', id: created.id }, 'admin-sub');
  const third = again.path.split('/').at(-1);
  assert.ok(await store.authorize(third));
  const disabled = await store.manage({ action: 'disable', id: created.id }, 'admin-sub');
  assert.equal(disabled.disabled, true);
  assert.equal(await store.authorize(third), null);
  assert.equal((await store.list()).length, 1, 'renew does not create duplicate management grants');
  const unauthorized = db.calls.filter(call => call instanceof sdk.GetCommand).every(call => call.input.ConsistentRead === true);
  assert.ok(unauthorized);
  await assert.rejects(store.manage({ action: 'create', expiresInDays: 0 }, 'admin'), error => error.status === 400);
  await assert.rejects(store.manage({ action: 'create', title: 'x', token: third }, 'admin'), error => error.status === 400);
});

test('only the three exact categories qualify; sold/deleted/merged/zero/invalid stock always loses', () => {
  assert.equal(policy.eligibleStage(baseRow(), cats()), 'repair');
  for (const id of ['hold', 'igarashi', 'other']) assert.equal(policy.eligibleStage({ ...baseRow(), categoryIds: [id] }, cats()), null);
  for (const fields of [{ categoryIds: ['repair', 'sold'] }, { quantity: 0 }, { quantity: -1 }, { quantity: null }, { quantity: '2' },
    { deletedAt: '2026-11-20' }, { isDeleted: true }, { listingPartition: 'MERGED' }, { saleEndDate: '2026-11-20' },
    { outboundBatchId: 'reserved' }, { mergedIntoInventoryId: 'other' }]) assert.equal(policy.eligibleStage({ ...baseRow(), ...fields }, cats()), null);
  assert.equal(policy.eligibleStage({ ...baseRow(), categoryIds: ['photo'] }, cats()), 'photo');
  assert.equal(policy.eligibleStage({ ...baseRow(), categoryIds: ['listing'] }, cats()), 'listing');
  assert.equal(policy.eligibleStage(baseRow(), policy.catalogCategories(masters.map(master => ({ ...master, isActive: false })))), null);
});

test('public serializer is an explicit allowlist and strips internal leading title annotations', () => {
  const token = 'a'.repeat(43);
  const result = policy.publicCatalogItem(baseRow(), cats(), token);
  assert.equal(result.name, 'ラウンジチェア');
  assert.equal(result.dimensions.height, null);
  assert.equal(result.dimensions.width, '60');
  assert.equal(result.images.length, 2);
  assert.equal(result.imageUrl, `/api/shared-inventory/${token}/image/item-1?index=0`);
  assert.equal(result.images[0], `${result.imageUrl}&size=full`);
  assert.notEqual(result.images[0], result.imageUrl, 'card preview stays small while gallery uses its scoped original');
  assert.equal(policy.catalogImageKey(baseRow(), 0), 'inventory/medium/top.webp');
  assert.equal(policy.catalogImageKey(baseRow(), 1), 'inventory/thumbnails/detail.jpg');
  assert.equal(policy.catalogImageKey(baseRow(), 0, true), 'inventory/top.jpg');
  assert.equal(policy.catalogImageKey(baseRow(), 1, true), 'inventory/detail.jpg');
  for (const forbidden of ['purchasePrice', 'salePrice', 'note', 'adminMemo', 'counterparty', 'customFields', 'PRIVATE_', '仕入先秘密', '取引先秘密', 'storageKey', 'sourceUrl']) {
    assert.ok(!JSON.stringify(result).includes(forbidden), forbidden);
  }
  assert.equal(policy.publicProductName(' 【secret】[private]（管理メモ） Sofa'), 'Sofa');
  assert.equal(policy.publicProductName('【secret】'), '商品');
  assert.equal(policy.catalogImageKey({ ...baseRow(), images: [{ storageKey: 'secrets/file.jpg', sortOrder: 0 }] }, 0), null);
  assert.equal(policy.catalogImageKey({ ...baseRow(), images: [{ storageKey: 'inventory/top.jpg', mediumKey: 'https://evil.invalid/image', sortOrder: 0 }] }, 0), null);
});

test('public service rejects missing/revoked capabilities before data reads and excludes all disallowed rows', async () => {
  const db = new MemoryDb();
  const store = grantsModule.createCatalogGrantStore(db, 'metadata');
  const created = await store.manage({ action: 'create' }, 'admin');
  const token = created.path.split('/').at(-1);
  let readCount = 0;
  const service = serviceModule.createPartnerCatalogService({ authorize: store.authorize, categories: async () => { readCount++; return cats(); },
    rows: async () => [baseRow(), { ...baseRow(), id: 'sold-one', categoryIds: ['sold', 'photo'] }, { ...baseRow(), id: 'zero', quantity: 0 },
      { ...baseRow(), id: 'deleted', deletedAt: 'now' }, { ...baseRow(), id: 'merged', listingPartition: 'MERGED' }],
    one: async () => baseRow(), image: async () => { throw new Error('not expected'); } });
  await assert.rejects(service.read('bad'), error => error.status === 404);
  await assert.rejects(service.read('x'.repeat(43)), error => error.status === 404);
  assert.equal(readCount, 0);
  const response = await service.read(token);
  assert.equal(response.items.length, 1);
  assert.equal(response.updatedAt, created.updatedAt > baseRow().updatedAt ? created.updatedAt : baseRow().updatedAt);
  assert.ok(!JSON.stringify(response).includes('PRIVATE_'));
  await store.manage({ action: 'disable', id: created.id }, 'admin');
  const count = readCount;
  await assert.rejects(service.read(token), error => error.status === 404);
  assert.equal(readCount, count);
});

test('image endpoint binds token, eligible item and selected photo; no arbitrary key/URL or stale sold image', async () => {
  const token = 'a'.repeat(43);
  const grant = { title: 'Catalog', expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', disabled: false };
  let current = baseRow();
  let authorized = true;
  let imageCalls = 0;
  let sellWhileReading = false;
  const service = serviceModule.createPartnerCatalogService({ authorize: async () => authorized ? grant : null,
    categories: async () => cats(), rows: async () => [current], one: async id => id === current.id ? current : null,
    image: async key => { imageCalls++; assert.equal(key, 'inventory/medium/top.webp'); if (sellWhileReading) current = { ...current, quantity: 0 }; return { bytes: new Uint8Array([1, 2]), contentType: 'image/webp' }; } });
  for (const [id, index] of [['unknown', 0], ['../../secret', 0], ['item-1', -1], ['item-1', 20], ['item-1', 1.1]]) {
    await assert.rejects(service.image(token, id, index), error => error.status === 404);
  }
  assert.equal(imageCalls, 0);
  assert.equal((await service.image(token, 'item-1', 0)).bytes.length, 2);
  current = { ...current, categoryIds: ['sold', 'repair'] };
  await assert.rejects(service.image(token, 'item-1', 0), error => error.status === 404);
  current = baseRow(); sellWhileReading = true;
  await assert.rejects(service.image(token, 'item-1', 0), error => error.status === 404);
  authorized = false;
  const before = imageCalls;
  await assert.rejects(service.image(token, 'item-1', 0), error => error.status === 404);
  assert.equal(imageCalls, before);
});

test('full images use the same capability and current product-photo binding before and after the original read', async () => {
  const token = 'a'.repeat(43);
  const grant = { title: 'Catalog', expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', disabled: false };
  let current = baseRow();
  let enabled = true;
  let mutate = () => {};
  const keys = [];
  const service = serviceModule.createPartnerCatalogService({ authorize: async () => enabled ? grant : null,
    categories: async () => cats(), rows: async () => [current], one: async id => id === current.id ? current : null,
    image: async key => { keys.push(key); mutate(); return { bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg' }; } });
  assert.equal((await service.image(token, 'item-1', 0, true)).bytes.length, 2);
  assert.equal(keys.at(-1), 'inventory/top.jpg');
  current = { ...baseRow(), categoryIds: ['sold', 'repair'] };
  await assert.rejects(service.image(token, 'item-1', 0, true), error => error.status === 404);
  assert.equal(keys.length, 1);
  current = baseRow();
  mutate = () => { current = { ...current, images: current.images.map(photo => photo.isPrimary ? { ...photo, storageKey: 'inventory/replaced.jpg' } : photo) }; };
  await assert.rejects(service.image(token, 'item-1', 0, true), error => error.status === 404, 'same preview key cannot authorize a changed original');
  current = baseRow();
  mutate = () => { enabled = false; };
  await assert.rejects(service.image(token, 'item-1', 0, true), error => error.status === 404, 'revocation during original read fails closed');
  const before = keys.length;
  await assert.rejects(service.image(token, 'item-1', 0, true), error => error.status === 404);
  assert.equal(keys.length, before);
});

test('image route only accepts a single optional size=full and never forwards arbitrary object parameters', async () => {
  const calls = [];
  const route = load('../../../app/api/shared-inventory/[token]/image/[id]/route.ts', {
    'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
    '@/lib/inventory/partnerCatalog/grants': grantsModule,
    '@/lib/inventory/partnerCatalog/server': {
      partnerCatalogResponseHeaders: { 'Cache-Control': 'private, no-store' },
      partnerCatalogServer: () => ({ image: async (...args) => { calls.push(args); return { bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg' }; } }),
      catalogFailure: error => ({ status: error.status ?? 503, error: error.message }),
    },
  }, { Response });
  const token = 'a'.repeat(43);
  const context = { params: Promise.resolve({ token, id: 'item-1' }) };
  const get = query => route.GET(new Request(`https://bello.invalid/api/shared-inventory/${token}/image/item-1${query}`), context);
  assert.equal((await get('?index=0')).status, 200);
  assert.deepEqual(calls.at(-1), [token, 'item-1', 0, false]);
  assert.equal((await get('?index=1&size=full')).status, 200);
  assert.deepEqual(calls.at(-1), [token, 'item-1', 1, true]);
  assert.equal((await get('?size=full')).status, 200);
  assert.deepEqual(calls.at(-1), [token, 'item-1', 0, true]);
  const before = calls.length;
  for (const query of ['?size=', '?size=preview', '?size=FULL', '?size=full&size=full', '?index=0&index=0',
    '?size=full&key=inventory/private.jpg', '?size=full&url=https://evil.invalid', '?index=20&size=full', '?index=-1&size=full']) {
    assert.equal((await get(query)).status, 404, query);
  }
  assert.equal(calls.length, before);
});

test('server byte reader verifies raster bytes for generic/missing MIME and retains the inventory prefix and 20MB guards', async () => {
  let object;
  let bodyReads = 0;
  const server = load('./server.ts', {
    'server-only': {}, '@aws-sdk/client-s3': { S3Client: class { async send(command) { assert.equal(command.input.Key, 'inventory/top.jpg'); return object; } }, GetObjectCommand: class { constructor(input) { this.input = input; } } },
    '../../../amplify_outputs.json': { storage: { aws_region: 'us-west-2', bucket_name: 'inventory-photos' } },
    '@/lib/amplify/requireInventoryUser': {}, '../mutationSession': {},
    '../categoryPersistence': { inventoryTable: () => 'metadata' }, './grants': grantsModule,
    './reader': { createCatalogReader: () => ({}) }, './service': { createPartnerCatalogService: ports => ports }, './policy': policy,
  });
  const image = server.partnerCatalogServer().image;
  const body = bytes => ({ transformToByteArray: async () => { bodyReads++; return new Uint8Array(bytes); } });
  const sharp = require('sharp');
  const raster = format => sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).toFormat(format).toBuffer();
  const jpeg = await raster('jpeg');
  object = { ContentType: 'image/jpeg', ContentLength: jpeg.length, Body: body(jpeg) };
  assert.equal((await image('inventory/top.jpg')).bytes.length, jpeg.length);
  object = { ContentType: 'image/jpeg', ContentLength: 20 * 1024 * 1024 + 1, Body: body(3) };
  await assert.rejects(image('inventory/top.jpg'), error => error.status === 404);
  assert.equal(bodyReads, 1, 'declared oversize is rejected before reading body');
  object = { ContentType: 'image/jpeg', ContentLength: 3, Body: body(20 * 1024 * 1024 + 1) };
  await assert.rejects(image('inventory/top.jpg'), error => error.status === 404);
  object = { ContentType: 'image/svg+xml', ContentLength: 3, Body: body(3) };
  await assert.rejects(image('inventory/top.jpg'), error => error.status === 404);
  await assert.rejects(image('secrets/private.jpg'), error => error.status === 404);
  for (const declared of ['application/octet-stream', undefined]) {
    object = { ContentType: declared, ContentLength: jpeg.length, Body: body(jpeg) };
    const accepted = await image('inventory/top.jpg');
    assert.equal(accepted.contentType, 'image/jpeg', 'generic metadata is replaced with the verified raster MIME');
    assert.deepEqual(Buffer.from(accepted.bytes), jpeg);
  }
  for (const format of ['png', 'webp', 'gif']) {
    const bytes = await raster(format);
    object = { ContentType: 'application/octet-stream', ContentLength: bytes.length, Body: body(bytes) };
    assert.equal((await image('inventory/top.jpg')).contentType, `image/${format}`, 'raster signature wins over the .jpg object filename');
  }
  for (const declared of ['application/octet-stream', 'image/jpeg', undefined]) {
    for (const text of ['<!doctype html><html><script>alert(1)</script></html>', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>']) {
      const bytes = Buffer.from(text);
      object = { ContentType: declared, ContentLength: bytes.length, Body: body(bytes) };
      await assert.rejects(image('inventory/top.jpg'), error => error.status === 404, `${declared} cannot authorize HTML/SVG bytes`);
    }
  }
  for (const declared of ['text/html', 'image/svg+xml']) {
    object = { ContentType: declared, ContentLength: jpeg.length, Body: body(jpeg) };
    await assert.rejects(image('inventory/top.jpg'), error => error.status === 404, 'explicit unsafe metadata remains rejected');
  }
});

test('administrator boundary rejects every nonadmin, unsigned and mismatched-owner session', async () => {
  let access = { kind: 'authorized', owner: 'admin-1', role: 'ADMIN' };
  let signature = { owner: 'admin-1', role: 'ADMIN' };
  const server = load('./server.ts', {
    'server-only': {}, '@aws-sdk/client-s3': { S3Client: class {}, GetObjectCommand: class {} },
    '../../../amplify_outputs.json': { storage: { aws_region: 'us-west-2' } },
    '@/lib/amplify/requireInventoryUser': { getVerifiedInventoryAccess: async () => access },
    '../mutationSession': { inventoryVerifiedReadSession: async () => signature },
    '../categoryPersistence': {}, './grants': grantsModule, './reader': { createCatalogReader: () => ({}) }, './service': {}, './policy': policy,
  });
  assert.equal((await server.requireCatalogAdmin()).owner, 'admin-1');
  for (const value of [{ kind: 'signed-out' }, { kind: 'signed-in-not-authorized' }, { kind: 'temporarily-unavailable' },
    { kind: 'authorized', owner: 'editor', role: 'EDITOR' }, { kind: 'authorized', owner: 'viewer', role: 'VIEWER' },
    { kind: 'authorized', owner: null, role: 'ADMIN' }]) {
    access = value;
    await assert.rejects(server.requireCatalogAdmin(), error => [401, 403, 503].includes(error.status));
  }
  access = { kind: 'authorized', owner: 'admin-1', role: 'ADMIN' };
  for (const value of [null, { owner: 'admin-2', role: 'ADMIN' }, { owner: 'admin-1', role: 'EDITOR' }]) {
    signature = value;
    await assert.rejects(server.requireCatalogAdmin(), error => error.status === 403);
  }
});

test('management route requires ADMIN before store access and refuses foreign origin or oversized JSON', async () => {
  let allowed = false;
  let accesses = 0;
  const route = load('../../../app/api/inventory/partner-catalog/route.ts', {
    'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
    '@/lib/outbound/requestOrigin': { isOutboundRequestOriginAllowed: request => request.headers.get('origin') === 'https://bello.invalid' },
    '@/lib/inventory/partnerCatalog/grants': grantsModule,
    '@/lib/inventory/partnerCatalog/server': {
      requireCatalogAdmin: async () => { if (!allowed) throw new grantsModule.CatalogError(403, 'forbidden'); return { owner: 'admin' }; },
      catalogGrantStore: () => { accesses++; return { list: async () => [], manage: async () => ({}) }; },
      partnerCatalogResponseHeaders: { 'Cache-Control': 'private, no-store' },
      catalogFailure: error => ({ status: error.status ?? 503, error: error.message }),
    },
  });
  const post = (body, origin = 'https://bello.invalid') => new Request('https://bello.invalid/api/inventory/partner-catalog', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await route.GET()).status, 403);
  assert.equal((await route.POST(post({ action: 'create' }))).status, 403);
  assert.equal(accesses, 0);
  allowed = true;
  assert.equal((await route.POST(post({ action: 'create' }, 'https://evil.invalid'))).status, 403);
  assert.equal((await route.POST(post({ action: 'create', label: 'x'.repeat(2049) }))).status, 400);
  assert.equal(accesses, 0);
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('reader only discovers bounded IDs and consistently rereads the narrow projection even on a cache hit', async () => {
  let now = 10000;
  let discovers = 0;
  let row = baseRow();
  const batches = [];
  const db = { send: async command => {
    const input = command.input;
    if (command instanceof sdk.ScanCommand && input.TableName === 'Category') return { Items: masters };
    if (command instanceof sdk.ScanCommand) {
      discovers++;
      assert.equal(input.ProjectionExpression, 'id'); assert.equal(input.TotalSegments, 4); assert.equal(input.ConsistentRead, true);
      return { Items: input.Segment === 0 ? [{ id: 'item-1' }] : [], ScannedCount: 1 };
    }
    if (command instanceof sdk.BatchGetCommand) {
      batches.push(input.RequestItems.Inventory);
      return { Responses: { Inventory: [row] } };
    }
    throw new Error('Unexpected command');
  } };
  const batch = load('../batchRead.ts', { 'server-only': {}, '@aws-sdk/lib-dynamodb': sdk });
  const readerModule = load('./reader.ts', { 'server-only': {}, '@aws-sdk/lib-dynamodb': sdk, '../batchRead': batch, './policy': policy });
  const reader = readerModule.createCatalogReader(db, name => name, () => now);
  await reader.rows(await reader.categories());
  assert.equal(discovers, 4);
  row = { ...row, quantity: 0 };
  const fresh = await reader.rows(await reader.categories());
  assert.equal(discovers, 4);
  assert.equal(fresh[0].quantity, 0, 'candidate cache cannot preserve an eligible product snapshot');
  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.equal(batch.ConsistentRead, true);
    const fields = Object.values(batch.ExpressionAttributeNames);
    for (const forbidden of ['purchasePrice', 'salePrice', 'note', 'adminMemo', 'counterpartyName', 'customFields']) assert.ok(!fields.includes(forbidden), forbidden);
  }
  now += 15001;
  await reader.rows(await reader.categories());
  assert.equal(discovers, 8);
});

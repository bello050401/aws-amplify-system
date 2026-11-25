// Run the real BASE entry points with local adapters only; no network or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '../..');
const id = '11111111-1111-4111-8111-111111111111';
let state;
function reset(change = {}) {
  const inventory = { id, name: 'Test chair', quantity: 3, updatedAt: 'inventory-v1', categoryId: 'sale', customFields: '{}' };
  state = {
    inventory, current: { ...inventory, ...change }, events: [], writes: [],
    draft: { id: 'draft-1', inventoryId: id, title: 'Test chair', price: 12000, images: [{ storageKey: 'fixture.jpg' }], updatedAt: 'draft-v1' },
    row: { id: `ec-base-${id}`, inventoryId: id, listingDraftId: 'draft-1', channel: 'BASE', status: 'DRAFT', updatedAt: 'row-v1', lastError: null },
  };
}
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
async function gql({ query, variables }) {
  const { input, condition } = variables;
  if (/mutation ClaimBase(Create|Manual)/.test(query)) {
    state.events.push('claim');
    assert.equal(condition.updatedAt.eq, state.row.updatedAt);
    assert.notEqual(state.row.status, 'PUBLISHING');
    state.row = { ...state.row, ...input, updatedAt: 'claimed-v2' };
    return { data: { updateChannelListing: { id: state.row.id, ...(state.missingClaimVersion ? {} : { updatedAt: state.row.updatedAt }) } } };
  }
  if (/mutation (ReleaseUnsentBaseCreate|FinishBaseManual)/.test(query)) {
    state.events.push('finish');
    assert.equal(condition.status.eq, 'PUBLISHING');
    const matches = condition.updatedAt ? condition.updatedAt.eq === state.row.updatedAt : condition.lastError.eq === state.row.lastError;
    if (!matches || state.row.status !== 'PUBLISHING') return { errors: ['conditional conflict'] };
    state.row = { ...state.row, ...input, updatedAt: 'finished-v3' };
    return { data: { updateChannelListing: { id: state.row.id } } };
  }
  throw Error('Unexpected GraphQL operation');
}
const models = {
  ListingDraft: { listListingDraftByInventoryId: async () => ({ data: [clone(state.draft)] }) },
  ChannelListing: {
    listChannelListingByInventoryId: async () => ({ data: state.row ? [clone(state.row)] : [] }),
    create: async input => { assert.equal(input.id, `ec-base-${id}`); state.row = { ...input, updatedAt: 'row-v1' }; return { data: clone(state.row) }; },
    update: async input => { state.row = { ...state.row, ...input }; return { data: clone(state.row) }; },
  },
};
function load(entry) {
  const cache = new Map();
  const mocks = {
    'server-only': {},
    'node:crypto': require('node:crypto'),
    '@/lib/amplify/dataClient': { inventoryAuthMode: {}, serverDataClient: { models, graphql: gql } },
    '@/lib/inventory/queries': { getInventoryDetail: async () => clone(state.inventory), listCategories: async () => [{ id: 'sale', name: '販売中' }] },
    '@/lib/inventory/categoryPersistence': { getInventoryRaw: async key => {
      assert.equal(key, id); assert.equal(state.row.status, 'PUBLISHING', 'fresh read must follow the claim');
      state.events.push('consistent-inventory-read');
      if (state.newOwner) state.row = { ...state.row, updatedAt: 'newer-owner', lastError: 'different-owner' };
      if (state.readFailure) throw Error('local read unavailable');
      return clone(state.current);
    } },
    '@/lib/inventory/masters': { listAllMasterEntries: async () => [{ id: 'sale', name: '販売中' }], normalizeMasterName: value => value.trim().normalize('NFKC') },
    '@/lib/base/connectionState': { getBaseConnectionState: async () => ({ requestWriteItems: true }) },
    '@/lib/base/oauth': { getAccessToken: async () => { throw Error('Unexpected token read'); } },
    '@/lib/amplify/listAll': { unwrapList: r => { if (r.errors) throw Error('read failure'); return r.data; } },
    '@/lib/amplify/structuredJson': { decodeStructuredJson: value => typeof value === 'string' ? JSON.parse(value) : value },
    '@/lib/shipping/packages': { normalizeShippingPackages: () => [] },
    '@/lib/inventory/e2eFixtures': { isE2EFixtureModeActive: () => false },
    '@/lib/listing/service': { getChannelListing: async () => clone(state.row), getListingDraftForInventory: async () => clone(state.draft) },
    '@/lib/listing/base/retry': { canRetryRejectedBaseCreate: () => false },
    '@/lib/listing/ecImage': { baseImageUrl: async () => { throw Error('Unexpected image read'); } },
    '@/lib/http/fetchWithTimeout': { fetchWithTimeout: async () => { throw Error('Unexpected HTTP request'); } },
  };
  const emptyModules = new Set([
    '@/lib/inventory/productDates', '@/lib/inventory/ecEligibleQuery', '@/lib/inventory/imageTypes', '@/lib/perf/queryTiming',
  ]);
  const adapter = { createBaseProduct: async input => {
    assert.equal(state.events.at(-1), 'consistent-inventory-read');
    state.events.push('remote-create'); state.writes.push(input.quantity);
    return { externalProductId: '1234', visibility: 'PRIVATE' };
  } };
  function moduleFor(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20', supported: { 'dynamic-import': false } }).code;
    const localRequire = spec => {
      if (Object.hasOwn(mocks, spec)) return mocks[spec];
      if (emptyModules.has(spec)) return {};
      let resolved = spec.startsWith('@/') ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(file), spec);
      const relative = path.relative(root, resolved).replaceAll('\\', '/');
      if (relative === 'lib/listing/base/adapter') return adapter;
      if (relative === 'lib/listing/base/privateTestGuard') return { isBasePrivateTestEnabled: () => true };
      if (relative === 'lib/listing/e2eFixtures' || relative === 'lib/listing/overviewFailure') return {};
      if (relative === 'lib/listing/commonSettings') return { normalizeChannelPrices: () => ({}), commonCategory: () => null, commonChannelPrice: draft => draft.price };
      const actual = new Set(['lib/listing/publishFlow', 'lib/listing/types', 'lib/listing/quantity', 'lib/listing/ecEligibility', 'lib/listing/base/errors', 'lib/listing/base/createInventoryGuard']);
      if (!actual.has(relative)) throw Error(`Unmocked import: ${spec}`);
      return moduleFor(resolved + '.ts');
    };
    vm.runInNewContext(code, { module: mod, exports: mod.exports, require: localRequire, console, process: { env: { BASE_MANUAL_LISTING_ENABLED: '1' } }, Date, setTimeout }, { filename: file });
    return mod.exports;
  }
  return moduleFor(path.join(root, entry));
}
(async () => {
  let cases = 0;
  for (const entry of ['lib/listing/service.ts', 'lib/listing/base/manualLifecycle.ts']) {
    const module = load(entry);
    const run = async () => entry.endsWith('/service.ts') ? module.listOnBase(id, 'fixture-user') : module.reviewBaseListing(id, 'PUBLISH');
    reset();
    await run();
    assert.deepEqual(state.writes, [3]); assert.equal(state.row.status, 'PAUSED'); cases++;
    const changed = [
      { quantity: 2, updatedAt: 'sold-v2' }, { quantity: 0 }, { updatedAt: 'edited-v2' },
      { saleEndDate: '2026-11-25' }, { deletedAt: '2026-11-25' }, { isDeleted: true },
      { listingPartition: 'MERGED' }, { outboundBatchId: 'out-1' }, { outboundArrivalBatchId: 'out-2' },
      { customFields: '{invalid' }, { customFields: JSON.stringify({ __belloYahooPayment: { state: 'WAITING' } }) },
    ];
    for (const change of changed) {
      reset(change);
      if (entry.endsWith('/service.ts')) await assert.rejects(run, /BASEには送信していません/);
      else assert.equal((await run()).status, 'BLOCKED');
      assert.equal(state.writes.length, 0); assert.equal(state.row.status, 'DRAFT', 'known pre-send abort must remain retryable'); cases++;
    }
    reset(); state.current = null;
    await run().catch(() => {}); assert.equal(state.writes.length, 0); assert.equal(state.row.status, 'DRAFT'); cases++;
    reset(); state.readFailure = true;
    await run().catch(() => {}); assert.equal(state.writes.length, 0); assert.equal(state.row.status, 'DRAFT'); cases++;
    reset(); delete state.inventory.updatedAt; delete state.current.updatedAt;
    await run().catch(() => {}); assert.equal(state.writes.length, 0); assert.equal(state.row.status, 'DRAFT'); cases++;
    reset({ updatedAt: 'sale-won' }); state.newOwner = true;
    await run().catch(() => {}); assert.equal(state.writes.length, 0); assert.equal(state.row.updatedAt, 'newer-owner'); assert.equal(state.row.lastError, 'different-owner', 'rollback must not overwrite another operation'); cases++;
    if (entry.endsWith('/service.ts')) {
      reset(); state.missingClaimVersion = true;
      await assert.rejects(run, /BASEには送信していません/); assert.equal(state.writes.length, 0); assert.equal(state.row.status, 'PUBLISHING'); cases++;
    } else {
      reset({ quantity: 2, updatedAt: 'sale-won' }); state.row = null;
      assert.equal((await run()).status, 'BLOCKED'); assert.equal(state.writes.length, 0); assert.equal(state.row.id, `ec-base-${id}`); assert.equal(state.row.status, 'DRAFT'); cases++;
    }
  }
  console.log(`PASS: BASE create inventory fence ${cases} cases; actual callers, no live marketplace writes.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

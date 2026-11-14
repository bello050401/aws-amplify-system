import assert from 'node:assert/strict';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildAnalysis } from '../lib/inventory/analysis/aggregate';
import { createAnalysisMetadataStore } from '../lib/inventory/analysis/metadata';
import { cleanAnalysisRetention, publishAnalysis } from '../lib/inventory/analysis/publication';
import { ANALYSIS_MAX_SHARDS, ANALYSIS_SHARD_BYTES, dailyKey, generationKey, makeAnalysisManifest, parseAnalysisManifest, shardKey } from '../lib/inventory/analysis/publicationFormat';
import { analysisRequest, createAnalysisReader, loadAnalysis } from '../lib/inventory/analysis/reader';
import { buildMonthlyAggregates } from '../lib/inventory/salesAggregate';
import { serializeSnapshotMonths } from '../lib/inventory/salesAggregateSnapshot';
import { buildInventoryValue } from '../lib/inventory/inventoryValue';

const FIRST = '2026-11-14T00:00:00.000Z';
const SECOND = '2026-11-14T06:00:00.000Z';
const workflow = [{ id: 'for-sale', name: '販売中' }];
const rows = [{ id: 'chair', sku: 'C-1', name: '椅子', quantity: 5, purchasePrice: 1500, categoryId: 'for-sale' }];
const firstBuild = buildAnalysis(rows, workflow, [], FIRST, FIRST);
const first = { ...firstBuild, inventory: firstBuild.inventory.map(({ holdingCount: _count, holdingBasis: _basis, ...fact }) => fact) };
const second = buildAnalysis(rows.map(row => ({ ...row, quantity: 2 })), workflow, [], SECOND, SECOND);
const legacy = buildMonthlyAggregates([{ id: 'sales-fixture', displayId: 'S-1', sku: 'S-1', name: '椅子',
  saleEndDate: '2026-11-10', salePrice: 5000, purchasePrice: 1500, shippingCost: 0 }]);

type Row = Record<string, any>;

function fixtureDb() {
  const items = new Map<string, Row>();
  const trace: string[] = [];
  let failBatch = false;
  let failRead = false;
  let winner: Row | null = null;
  function key(table: string, item: Row) { return [table, item.scope ?? '', item.id].join('/'); }
  const db = { send: async command => {
    const input = command.input as Row;
    const { TableName, Item, Key, RequestItems, TransactItems } = input;
    trace.push(command.constructor.name);
    if (command instanceof GetCommand) {
      if (failRead) throw new Error('network');
      return { Item: items.get(key(TableName, Key)) };
    }
    if (command instanceof BatchGetCommand) return { Responses: Object.fromEntries(Object.entries(RequestItems).map(([table, batch]) =>
      [table, (batch as Row).Keys.flatMap((id: Row) => items.get(key(table, id)) ?? [])])) };
    if (command instanceof PutCommand) {
      const id = key(TableName, Item);
      if (items.has(id)) throw new ConditionalCheckFailedException({ $metadata: {}, message: "fixture condition rejected" });
      items.set(id, Item);
      return {};
    }
    if (command instanceof BatchWriteCommand) {
      for (const [table, writes] of Object.entries(RequestItems)) {
        for (const write of writes as Row[]) {
          if (write.PutRequest) items.set(key(table, write.PutRequest.Item), write.PutRequest.Item);
          else items.delete(key(table, write.DeleteRequest.Key));
          if (failBatch) throw new Error('hard shard write failure');
        }
      }
      return {};
    }
    if (command instanceof QueryCommand) {
      const { ':scope': scope, ':group': group, ':now': now, ':prefix': prefix } = input.ExpressionAttributeValues;
      return { Items: [...items].filter(([id]) => id.startsWith(TableName + '/')).map(([, row]) => row)
        .filter(item => group ? item.analysisRetentionGroup === group && item.analysisRetainUntil <= now
          : item.scope === scope && (!prefix || item.id.startsWith(prefix)))
        .slice(0, input.Limit) };
    }
    if (command instanceof DeleteCommand) {
      items.delete(key(TableName, Key));
      return {};
    }
    if (command instanceof UpdateCommand) {
      const saved = items.get(key(TableName, Key));
      assert(saved);
      items.set(key(TableName, Key), { ...saved, analysisRetainUntil: input.ExpressionAttributeValues[':until'], analysisShardIds: input.ExpressionAttributeValues[':ids'] });
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const firstPut = TransactItems[0].Put;
      if (firstPut.Item.id === 'current' && winner) {
        items.set(key(firstPut.TableName, winner), winner);
        winner = null;
        throw new TransactionCanceledException({ $metadata: {}, message: "fixture condition rejected", CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
      }
      const check = TransactItems.findIndex((entry: Row) => entry.ConditionCheck);
      if (check !== -1 && !items.has(key(TransactItems[check].ConditionCheck.TableName, TransactItems[check].ConditionCheck.Key))) {
        const reasons = TransactItems.map((_: Row, i: number) => ({ Code: i === check ? 'ConditionalCheckFailed' : 'None' }));
        throw new TransactionCanceledException({ $metadata: {}, message: "fixture condition rejected", CancellationReasons: reasons });
      }
      for (const entry of TransactItems) {
        if (entry.Put) items.set(key(entry.Put.TableName, entry.Put.Item), entry.Put.Item);
        if (entry.Update) {
          const prior = items.get(key(entry.Update.TableName, entry.Update.Key));
          assert(prior);
          items.set(key(entry.Update.TableName, entry.Update.Key), { ...prior, analysisManifestJson: entry.Update.ExpressionAttributeValues[':manifest'] });
        }
      }
      return {};
    }
    throw new Error('Unrecognized command ' + command.constructor.name);
  } } as Pick<DynamoDBDocumentClient, 'send'>;
  return { items, db, trace, key, failBatch: () => { failBatch = true; }, failRead: () => { failRead = true; },
    setWinner: (item: Row) => { winner = item; } };
}

async function publication() {
  const f = fixtureDb();
  const table = 'snapshot';
  const now = Date.parse(SECOND);
  assert.equal((await loadAnalysis(f.db, table, { target: 'inventory' }, now)).status, 'missing');
  assert.equal(await publishAnalysis(f.db, table, first, legacy, 'fixture'), true);
  const legacyCurrent = f.items.get('snapshot//current')!;
  assert.equal(legacyCurrent.inventoryValueJson, JSON.stringify(buildInventoryValue(rows, workflow, FIRST)));
  assert.equal(legacyCurrent.monthsJson, serializeSnapshotMonths(legacy));
  assert.equal(JSON.parse(legacyCurrent.analysisManifestJson).header.metadata.generation, FIRST);
  assert(f.trace.indexOf('BatchWriteCommand') < f.trace.indexOf('TransactWriteCommand'));
  assert.equal(await publishAnalysis(f.db, table, second, legacy, 'fixture'), true);
  assert.equal(await publishAnalysis(f.db, table, first, legacy, 'fixture'), false);
  const pinned = await loadAnalysis(f.db, table, { target: 'inventory', generation: FIRST }, now);
  assert(pinned.status === 'ok');
  assert.equal(pinned.build.inventory[0].quantity, 5);
  const dailyPinned = await loadAnalysis(f.db, table, { target: 'inventory', daily: '2026-11-14', generation: FIRST }, now);
  assert(dailyPinned.status === 'ok');
  assert.equal(dailyPinned.build.inventory[0].quantity, 5);
  const latest = await loadAnalysis(f.db, table, { target: 'inventory', daily: '2026-11-14' }, now);
  assert(latest.status === 'ok');
  assert.equal(latest.build.inventory[0].quantity, 2);
  assert.equal(latest.build.inventory[0].holdingCount, 2);
  assert.equal(pinned.build.inventory[0].holdingCount, undefined);
  const reader = createAnalysisReader({ authorize: async () => true, load: request => loadAnalysis(f.db, table, request, now) });
  const pinnedRequest = { target: 'inventory', daily: '2026-11-14', generation: FIRST };
  const pinnedSummary = await reader.summary(pinnedRequest);
  assert(pinnedSummary.status === 'ok');
  assert.equal(pinnedSummary.summary.dimensions.holdingCount?.[0].key, '5');
  const pinnedDetail = await reader.detail({ ...pinnedRequest, dimension: 'holdingCount', key: '5' });
  assert(pinnedDetail.status === 'ok');
  assert.deepEqual(pinnedDetail.items.map(item => item.type === 'record' && [item.record.id, item.record.holdingCount, item.record.holdingBasis]), [['chair', 5, 'inventory-record']]);
  const currentDetail = await reader.detail({ ...pinnedRequest, generation: SECOND, dimension: 'holdingCount', key: '5' });
  assert(currentDetail.status === 'ok');
  assert.equal(currentDetail.items.length, 0);
  const shard = f.items.get('snapshot//' + shardKey(SECOND, 'inventory', 0))!;
  const parsed = JSON.parse(shard.analysisShardJson);
  parsed[0].title = '柿子';
  shard.analysisShardJson = JSON.stringify(parsed);
  assert.equal((await loadAnalysis(f.db, table, { target: 'inventory' }, now)).status, 'error');
  assert.equal((await loadAnalysis(f.db, table, { target: 'inventory', generation: FIRST }, Date.parse('2026-11-30'))).status, 'expired');
  assert.equal((await loadAnalysis(f.db, table, { target: 'inventory', daily: '2026-11-13' }, now)).status, 'missing');
  f.failRead();
  assert.equal((await loadAnalysis(f.db, table, { target: 'inventory' }, now)).status, 'error');

  const broken = fixtureDb();
  await publishAnalysis(broken.db, table, first, legacy, 'fixture');
  broken.failBatch();
  await assert.rejects(() => publishAnalysis(broken.db, table, second, legacy, 'fixture'), /hard shard write failure/);
  assert.equal(broken.items.get('snapshot//current')?.generation, FIRST);
  assert.equal(broken.items.get('snapshot//' + generationKey(SECOND))?.analysisManifestJson, undefined);
  assert.equal(broken.items.get('snapshot//' + dailyKey('2026-11-14'))?.generation, FIRST);
  const concurrent = fixtureDb();
  concurrent.setWinner({ id: 'current', generation: SECOND, monthsJson: '[]' });
  assert.equal(await publishAnalysis(concurrent.db, table, first, legacy, 'fixture'), false);
  assert.equal(concurrent.items.get('snapshot//current')?.generation, SECOND);

  const thirdGeneration = '2026-11-15T00:00:00.000Z';
  const retained = fixtureDb();
  const third = buildAnalysis(rows, workflow, [], thirdGeneration, thirdGeneration);
  for (const build of [first, second, third]) await publishAnalysis(retained.db, table, build, legacy, 'fixture');
  await cleanAnalysisRetention(retained.db, table, Date.parse('2026-11-30'));
  assert(!retained.items.has('snapshot//' + generationKey(FIRST)));
  assert(!retained.items.has('snapshot//' + shardKey(FIRST, 'inventory', 0)));
  assert(retained.items.has('snapshot//' + shardKey(SECOND, 'inventory', 0)));
  assert(retained.items.has('snapshot//' + shardKey(thirdGeneration, 'inventory', 0)));
  assert.equal((await loadAnalysis(retained.db, table, { target: 'inventory', daily: '2026-11-14' }, Date.parse('2026-11-30'))).status, 'ok');
  await cleanAnalysisRetention(retained.db, table, Date.parse('2027-03-01'));
  assert(!retained.items.has('snapshot//' + shardKey(SECOND, 'inventory', 0)));
  assert(retained.items.has('snapshot//' + shardKey(thirdGeneration, 'inventory', 0)));

  const fact = first.inventory[0];
  assert.throws(() => makeAnalysisManifest({ ...first, inventory: [{ ...fact, title: '観'.repeat(ANALYSIS_SHARD_BYTES) }] }), /ANALYSIS_FACT_TOO_LARGE/);
  const manifest = makeAnalysisManifest(first).manifest;
  manifest.targets.inventory = Array.from({ length: ANALYSIS_MAX_SHARDS + 1 }, () => ({ hash: 'a'.repeat(64), bytes: 5, records: 1 }));
  assert.throws(() => parseAnalysisManifest(JSON.stringify(manifest), FIRST), /ANALYSIS_MANIFEST_INVALID/);
}

async function metadata() {
  const f = fixtureDb();
  const store = createAnalysisMetadataStore(f.db, 'metadata');
  const result = await store.inspect();
  assert(result.status === 'ok');
  assert.equal(result.taxonomyRevision, 1);
  assert.equal(result.categories[0].label, 'ソファ');
  const value = { type: 'taxonomy', categories: result.categories };
  assert.deepEqual(await store.save({ type: 'taxonomy', value, expectedRevision: 1 }, 'admin', () => 'inventory'),
    { status: 'ok', revision: 2, rebuildRequired: true });
  assert.deepEqual(await store.save({ type: 'taxonomy', value, expectedRevision: 1 }, 'admin', () => 'inventory'), { status: 'conflict' });
  const indexed = await store.forRebuild();
  assert.equal(indexed.epoch, 1);
  assert.equal(indexed.rows[0].revision, 2);
  assert.equal(f.items.get('metadata/audit:taxonomy/0000000002')?.changedBy, 'admin');
  assert.equal((await store.save({ type: 'taxonomy', value: { ...value, categories: result.categories.slice(1) }, expectedRevision: 2 }, 'admin', () => 'inventory')).status, 'invalid');
  const record = { type: 'inventory', inventoryId: 'chair', categoryId: 'misspelled', categoryState: 'confirmed',
    kindId: null, kindState: 'unknown', lotId: null, lotState: 'unknown', salesQuantity: null, salesQuantityEvidence: null,
    retail: 'unknown', saleCostTotal: null, saleCostEvidence: null };
  const save = (value: Row) => store.save({ type: 'inventory', expectedRevision: 0, value }, 'admin', () => 'inventory');
  assert.equal((await save(record)).status, 'invalid');
  assert.equal((await save({ ...record, categoryId: 'sofa' })).status, 'invalid');
  f.items.set('inventory//chair', { id: 'chair', categoryId: 'workflow' });
  assert.equal((await save({ ...record, categoryId: 'sofa' })).status, 'ok');
  assert.equal(f.items.get('inventory//chair')?.categoryId, 'workflow');
  const lotValue = { type: 'lot', id: 'unscoped', source: 'restage', sourceRecordId: 'fixture', state: 'confirmed',
    date: '2026-11-14', quantity: 5, costTotal: 500, categoryId: 'sofa', kindId: null, merchandise: true,
    operation: 'acquisition', originalLotId: null };
  assert.equal((await store.save({ type: 'lot', expectedRevision: 0, value: lotValue }, 'admin', () => 'inventory')).status, 'invalid');
}

async function main() {
  await publication();
  await metadata();
  let calls = 0;
  const reader = createAnalysisReader({ authorize: async () => false, load: async () => { calls++; return { status: 'missing' }; } });
  assert.equal((await reader.summary({ target: 'inventory' })).status, 'error');
  assert.equal((await reader.detail({ target: 'inventory', generation: FIRST })).status, 'error');
  assert.equal(calls, 0);
  assert.equal(analysisRequest({ target: 'sales', start: '2026-02-31', end: '2026-03-01' }, false), null);
  assert.equal(analysisRequest({ target: 'inventory', generation: FIRST, limit: 101 }, true), null);
  assert.equal(analysisRequest({ target: 'sales', rollingDays: 90 }, false), null);
  assert.equal(analysisRequest({ target: 'inventory', rollingDays: 30 }, false), null);
  assert.equal(analysisRequest({ target: 'sales', rollingDays: 30, start: '2026-11-01', end: '2026-11-30' }, false), null);
  assert.deepEqual(analysisRequest({ target: 'sales', rollingDays: 30 }, false), { target: 'sales', rollingDays: 30 });
  console.log('PASS: atomic publication, legacy totals, races, hash and bounds, pinned daily/generation reads, retention, metadata revisions, authorization order');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

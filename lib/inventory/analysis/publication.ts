import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type BatchWriteCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SALES_AGGREGATE_SNAPSHOT_ID, serializeSnapshotMonths } from '../salesAggregateSnapshot';
import type { SalesMonthlyAggregateRow } from '../salesAggregate';
import { ANALYSIS_MAX_SHARDS, ANALYSIS_RETAIN_DAILY, ANALYSIS_RETAIN_GENERATIONS, ANALYSIS_RETENTION_INDEX, dailyKey, generationKey, isAnalysisGeneration, makeAnalysisManifest, parseAnalysisManifest, shardKey, ANALYSIS_TARGETS } from './publicationFormat';
import { jstDay } from './period';
import type { AnalysisBuild } from './types';

type Db = Pick<DynamoDBDocumentClient, 'send'>;
type Item = Record<string, unknown>;
const DAY = 86400;
const SEC = 1000;
const conditional = (error: unknown) => error instanceof ConditionalCheckFailedException;
const get = async (db: Db, TableName: string, id: string) => (await db.send(new GetCommand({ TableName, Key: { id }, ConsistentRead: true }))).Item;

function row(id: string, generation: string, sourceRecordCount: number, rebuiltBy: string) {
  return {
    id, __typename: 'SalesAggregateSnapshot', generation, monthsJson: '[]', sourceRecordCount, rebuiltBy,
    rebuiltAt: generation, createdAt: generation, updatedAt: generation,
  };
}

type Mutation = NonNullable<BatchWriteCommandInput['RequestItems']>[string][number];

async function writeBatch(db: Db, table: string, mutations: Mutation[]) {
  for (let offset = 0; offset < mutations.length; offset += 25) {
    let pending = mutations.slice(offset, offset + 25);
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 5) throw new Error('ANALYSIS_SHARD_WRITE_INCOMPLETE');
      if (attempt) await new Promise(resolve => setTimeout(resolve, 30 * 2 ** (attempt - 1)));
      const result = await db.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = result.UnprocessedItems?.[table] ?? [];
    }
  }
}

export async function publishAnalysis(db: Db, table: string, build: AnalysisBuild, months: SalesMonthlyAggregateRow[], actor: string) {
  const { manifest, dailyManifest, shards } = makeAnalysisManifest(build);
  const { generation, sourceRecordCount, coverageEnd } = manifest.header.metadata;
  const manifestJson = JSON.stringify(manifest);
  const dailyJson = JSON.stringify(dailyManifest);
  parseAnalysisManifest(manifestJson, generation);
  parseAnalysisManifest(dailyJson, generation);
  const base = (id: string) => row(id, generation, sourceRecordCount, actor);
  const current = {
    ...base(SALES_AGGREGATE_SNAPSHOT_ID),
    monthsJson: serializeSnapshotMonths(months),
    inventoryValueJson: JSON.stringify(build.inventoryValue),
    analysisManifestJson: manifestJson,
  };
  for (const item of [current, { ...base(dailyKey(coverageEnd)), analysisManifestJson: dailyJson }]) {
    if (Buffer.byteLength(JSON.stringify(item)) > 390 * 1024) throw new Error('ANALYSIS_MANIFEST_TOO_LARGE');
  }
  const previous = await get(db, table, SALES_AGGREGATE_SNAPSHOT_ID);
  if (previous && typeof previous.generation === 'string' && previous.generation >= generation) return false;

  const id = generationKey(generation);
  const expires = Math.floor(Date.parse(generation) / SEC) + ANALYSIS_RETAIN_GENERATIONS;
  // Reserve this timestamp before writing shards. A colliding worker cannot mutate any of these keys.
  try {
    await db.send(new PutCommand({
      TableName: table, Item: { ...base(id), analysisShardIds: shards.map(shard => shard.id), analysisRetentionGroup: 'generation', analysisRetainUntil: expires },
      ConditionExpression: 'attribute_not_exists(id)',
    }));
  } catch (error) {
    if (conditional(error)) return false;
    throw error;
  }
  await writeBatch(db, table, shards.map(shard => ({ PutRequest: { Item: { ...base(shard.id), analysisShardJson: shard.json } } })));

  try {
    // The conditional Put keeps the old legacy totals and analysis intact until every shard is durable.
    await db.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: table, Item: current,
        ConditionExpression: 'attribute_not_exists(id) OR generation < :new',
        ExpressionAttributeValues: { ':new': generation },
      } },
      { Update: {
        TableName: table, Key: { id }, ConditionExpression: 'generation = :new AND attribute_not_exists(analysisManifestJson)',
        UpdateExpression: 'SET analysisManifestJson = :manifest',
        ExpressionAttributeValues: { ':new': generation, ':manifest': manifestJson },
      } },
      { Put: {
        TableName: table, Item: {
          ...base(dailyKey(coverageEnd)), analysisManifestJson: dailyJson, analysisRetentionGroup: 'daily',
          analysisRetainUntil: Math.floor(Date.parse(coverageEnd) / SEC) + ANALYSIS_RETAIN_DAILY + DAY,
        },
        ConditionExpression: 'attribute_not_exists(id) OR generation < :new',
        ExpressionAttributeValues: { ':new': generation },
      } },
    ] }));
  } catch (error) {
    if (error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false;
    throw error;
  }
  return true;
}

function cleanupIds(item: Item) {
  if (!isAnalysisGeneration(item.generation) || item.id !== generationKey(item.generation) ||
      !Array.isArray(item.analysisShardIds) || item.analysisShardIds.length > ANALYSIS_MAX_SHARDS) throw new Error('ANALYSIS_RETENTION_INVALID');
  const allowed = new Set(ANALYSIS_TARGETS.flatMap(target => Array.from({ length: ANALYSIS_MAX_SHARDS }, (_, i) => shardKey(item.generation as string, target, i))));
  if (!item.analysisShardIds.every(id => allowed.has(id))) throw new Error('ANALYSIS_RETENTION_INVALID');
  return item.analysisShardIds as string[];
}

export async function cleanAnalysisRetention(db: Db, table: string, now = Date.now()) {
  const seconds = Math.floor(now / SEC);
  for (const group of ['generation', 'daily']) {
    // Modest bound per run. A failed run leaves its ledger for a later retry.
    const overdue = await db.send(new QueryCommand({
      TableName: table, IndexName: ANALYSIS_RETENTION_INDEX, Limit: 12,
      KeyConditionExpression: 'analysisRetentionGroup = :group AND analysisRetainUntil <= :now',
      ExpressionAttributeValues: { ':group': group, ':now': seconds },
      ProjectionExpression: 'id',
    }));
    for (const { id } of overdue.Items ?? []) {
      if (typeof id !== 'string') continue;
      const record = await get(db, table, id);
      if (!record || record.analysisRetentionGroup !== group || !isAnalysisGeneration(record.generation) ||
          typeof record.analysisRetainUntil !== 'number' || record.analysisRetainUntil > seconds) continue;
      const generation = record.generation;
      const day = jstDay(generation);
      if (group === 'daily') {
        if (id !== dailyKey(day)) throw new Error('ANALYSIS_RETENTION_INVALID');
        await db.send(new DeleteCommand({ TableName: table, Key: { id }, ConditionExpression: 'generation = :generation',
          ExpressionAttributeValues: { ':generation': generation } })).catch(error => { if (!conditional(error)) throw error; });
        continue;
      }

      const ids = cleanupIds(record);
      const [current, daily] = await Promise.all([get(db, table, SALES_AGGREGATE_SNAPSHOT_ID), get(db, table, dailyKey(day))]);
      const pinnedCurrent = current?.generation === generation;
      const dailyUntil = daily?.generation === generation && typeof daily.analysisRetainUntil === 'number' ? daily.analysisRetainUntil : 0;
      const pinnedDaily = dailyUntil > seconds;
      const inventoryPrefix = 'analysis:s:' + generation + ':inventory:';
      const deletions = pinnedCurrent ? [] : ids.filter(shard => !pinnedDaily || !shard.startsWith(inventoryPrefix));
      await writeBatch(db, table, deletions.map(id => ({ DeleteRequest: { Key: { id } } })));
      if (pinnedCurrent || pinnedDaily) {
        const retainedIds = pinnedCurrent ? ids : ids.filter(shard => shard.startsWith(inventoryPrefix));
        await db.send(new UpdateCommand({
          TableName: table, Key: { id }, ConditionExpression: 'generation = :generation',
          UpdateExpression: 'SET analysisRetainUntil = :until, analysisShardIds = :ids',
          ExpressionAttributeValues: { ':generation': generation, ':until': pinnedCurrent ? seconds + DAY : dailyUntil, ':ids': retainedIds },
        })).catch(error => { if (!conditional(error)) throw error; });
      } else {
        await db.send(new DeleteCommand({ TableName: table, Key: { id }, ConditionExpression: 'generation = :generation',
          ExpressionAttributeValues: { ':generation': generation } })).catch(error => { if (!conditional(error)) throw error; });
      }
    }
  }
}

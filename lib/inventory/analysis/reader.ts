import { BatchGetCommand, GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dateOnly, jstDay } from './period';
import { ANALYSIS_RETAIN_GENERATIONS, ANALYSIS_TARGETS, dailyKey, generationKey, isAnalysisGeneration, parseAnalysisManifest, parseAnalysisShard, shardKey } from './publicationFormat';
import { drilldownAnalysis, queryAnalysis } from './query';
import { isSkuDimension, isSkuGroupKey } from './skus';
import type { AnalysisBuild, AnalysisRequest, AnalysisResult, DetailResult, Dimension, DrilldownRequest } from './types';

type Db = Pick<DynamoDBDocumentClient, 'send'>;
type ReadResult = { status: 'ok'; build: AnalysisBuild } | { status: 'missing' | 'error' | 'expired' };
const dimensions = new Set<Dimension>(['category', 'holding', 'holdingBand', 'holdingCount', 'lot', 'lotBand', 'skuCategory', 'skuHoldingCount']);
const summaryKeys = ['target', 'start', 'end', 'daily', 'generation', 'rollingDays'];
const detailKeys = [...summaryKeys, 'dimension', 'key', 'groupKindId', 'groupSku', 'cursor', 'limit'];

export function analysisRequest(value: unknown, detail: true): DrilldownRequest | null;
export function analysisRequest(value: unknown, detail: false): AnalysisRequest | null;
export function analysisRequest(value: unknown, detail: boolean): AnalysisRequest | DrilldownRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => !(detail ? detailKeys : summaryKeys).includes(key))) return null;
  if (!(ANALYSIS_TARGETS as readonly unknown[]).includes(request.target)) return null;
  for (const key of ['start', 'end', 'daily']) {
    const entry = request[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || entry.length !== 10) return null;
    try { dateOnly(entry); } catch { return null; }
  }
  if ((detail || request.generation !== undefined) && !isAnalysisGeneration(request.generation)) return null;
  if (request.rollingDays !== undefined && (request.rollingDays !== 30 || request.target !== 'sales' ||
      request.start !== undefined || request.end !== undefined || request.daily !== undefined)) return null;
  if (request.daily && (request.target !== 'inventory' || request.start || request.end)) return null;
  if (request.target === 'inventory' && (request.start || request.end)) return null;
  if (request.target === 'sales' && (request.start === undefined) !== (request.end === undefined)) return null;
  if (typeof request.start === 'string' && typeof request.end === 'string' &&
      (request.start > request.end || Date.parse(request.end) - Date.parse(request.start) > 3660 * 86400_000)) return null;
  if (detail) {
    if ((request.dimension === undefined) !== (request.key === undefined)) return null;
    if (request.dimension !== undefined && !dimensions.has(request.dimension as Dimension)) return null;
    for (const [key, max] of [['key', 256], ['groupKindId', 256], ['cursor', 3000]] as const) {
      const entry = request[key];
      if (entry !== undefined && (typeof entry !== 'string' || !entry.length || entry.length > max)) return null;
    }
    if (request.limit !== undefined && (typeof request.limit !== 'number' || !Number.isInteger(request.limit) ||
        request.limit < 1 || request.limit > 100)) return null;
    const skuDimension = isSkuDimension(request.dimension as Dimension | undefined);
    if (skuDimension && request.target !== 'inventory') return null;
    if (request.groupSku !== undefined && (!skuDimension || !isSkuGroupKey(request.groupSku))) return null;
    if (request.groupKindId && (skuDimension || (request.target !== 'inventory' && request.target !== 'acquisitions'))) return null;
  }
  return request as unknown as AnalysisRequest | DrilldownRequest;
}

async function readShards(db: Db, table: string, keys: string[]) {
  const found = new Map<string, unknown>();
  // Four bounded chunks in flight. At 16 x 240 KiB, each request stays below the 16 MiB response ceiling.
  for (let offset = 0; offset < keys.length; offset += 64) {
    const group = keys.slice(offset, offset + 64);
    await Promise.all(Array.from({ length: Math.ceil(group.length / 16) }, async (_, batch) => {
      let pending = group.slice(batch * 16, batch * 16 + 16).map(id => ({ id }));
      for (let attempt = 0; pending.length; attempt++) {
        if (attempt === 5) throw new Error('ANALYSIS_SHARD_READ_INCOMPLETE');
        if (attempt) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** (attempt - 1)));
        const result = await db.send(new BatchGetCommand({ RequestItems: {
          [table]: { Keys: pending, ConsistentRead: true, ProjectionExpression: 'id, analysisShardJson' },
        } }));
        const expected = new Set(pending.map(key => key.id));
        for (const item of result.Responses?.[table] ?? []) {
          if (!expected.has(item.id) || found.has(item.id)) throw new Error('ANALYSIS_SHARD_READ_INVALID');
          found.set(item.id, item.analysisShardJson);
        }
        pending = (result.UnprocessedKeys?.[table]?.Keys ?? []).map(item => {
          if (!expected.has(item.id) || found.has(item.id)) throw new Error('ANALYSIS_SHARD_READ_INVALID');
          return { id: item.id };
        });
      }
    }));
  }
  return found;
}

export async function loadAnalysis(db: Db, table: string, request: AnalysisRequest, now = Date.now(), onReadError?: (error: unknown) => Promise<unknown>): Promise<ReadResult> {
  try {
    const seconds = Math.floor(now / 1000);
    const getPointer = async (id: string) => (await db.send(new GetCommand({
      TableName: table, Key: { id }, ConsistentRead: true,
      ProjectionExpression: 'generation, analysisManifestJson, analysisRetainUntil',
    }))).Item;
    let pointer;
    if (request.daily) {
      pointer = await getPointer(dailyKey(request.daily));
      if (!pointer || typeof pointer.analysisRetainUntil !== 'number' || pointer.analysisRetainUntil <= seconds) {
        return { status: request.generation ? 'expired' : 'missing' };
      }
      if (request.generation && request.generation !== pointer.generation) {
        // A subsequent capture on the same JST day must not change the drilldown rows.
        pointer = await getPointer(generationKey(request.generation));
        if (!pointer?.analysisManifestJson || request.generation !== pointer.generation ||
            jstDay(request.generation) !== request.daily ||
            Date.parse(request.generation) / 1000 + ANALYSIS_RETAIN_GENERATIONS <= seconds) return { status: 'expired' };
      }
    } else {
      pointer = await getPointer('current');
      if (request.generation && request.generation !== pointer?.generation) {
        if (Date.parse(request.generation) / 1000 + ANALYSIS_RETAIN_GENERATIONS <= seconds) return { status: 'expired' };
        pointer = await getPointer(generationKey(request.generation));
        if (!pointer?.analysisManifestJson) return { status: 'expired' };
      }
      if (!pointer || pointer.analysisManifestJson === undefined || pointer.analysisManifestJson === null) {
        return { status: request.generation ? 'expired' : 'missing' };
      }
    }
    if (!isAnalysisGeneration(pointer.generation)) return { status: 'error' };
    const manifest = parseAnalysisManifest(pointer.analysisManifestJson, pointer.generation);
    if (request.daily && manifest.header.metadata.coverageEnd !== request.daily) return { status: 'error' };
    const descriptors = manifest.targets[request.target];
    const keys = descriptors.map((_, index) => shardKey(pointer.generation, request.target, index));
    const found = await readShards(db, table, keys);
    const build: AnalysisBuild = {
      ...manifest.header, inventory: [], sales: [], acquisitions: [], retailReference: [],
      [request.target]: descriptors.flatMap((descriptor, index) => parseAnalysisShard(found.get(keys[index]), descriptor)),
    };
    return { status: 'ok', build };
  } catch (error) {
    // An observer cannot change the read result or expose SDK payloads to callers.
    try { await onReadError?.(error); } catch { /* best effort */ }
    return { status: 'error' };
  }
}

export function createAnalysisReader(deps: { authorize: () => Promise<boolean>; load: (request: AnalysisRequest) => Promise<ReadResult> }) {
  return {
    async summary(input: unknown): Promise<AnalysisResult> {
      if (!await deps.authorize()) return { status: 'error' };
      const request = analysisRequest(input, false);
      if (!request) return { status: 'error' };
      const loaded = await deps.load(request);
      return loaded.status === 'ok' ? queryAnalysis(loaded.build, request) : loaded;
    },
    async detail(input: unknown): Promise<DetailResult> {
      if (!await deps.authorize()) return { status: 'error' };
      const request = analysisRequest(input, true);
      if (!request) return { status: 'error' };
      const loaded = await deps.load(request);
      return loaded.status === 'ok' ? drilldownAnalysis(loaded.build, request) : loaded;
    },
  };
}

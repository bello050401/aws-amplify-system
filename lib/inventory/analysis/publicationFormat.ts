import { createHash } from 'node:crypto';
import { parseInventoryValue } from '../inventoryValue';
import { dateOnly, jstDay } from './period';
import { ANALYSIS_VERSION, type AnalysisBuild, type Fact, type Target } from './types';

export const ANALYSIS_SHARD_BYTES = 240 * 1024;
export const ANALYSIS_MAX_SHARDS = 128;
export const ANALYSIS_MAX_TARGET_BYTES = 12 * 1024 * 1024;
export const ANALYSIS_RETAIN_GENERATIONS = 7 * 86400;
export const ANALYSIS_RETAIN_DAILY = 90 * 86400;
export const ANALYSIS_RETENTION_INDEX = 'AnalysisRetention';
export const ANALYSIS_TARGETS = ['inventory', 'sales', 'acquisitions', 'retailReference'] as const;
export const ANALYSIS_INVENTORY_PROJECTION = 'id, sku, #n, saleEndDate, salePrice, purchasePrice, shippingCost, deletedAt, quantity, categoryId, categoryIds, sourceInventoryId, sourceSystem, customFields, transactionDate, market, images';

export function isAnalysisGeneration(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export const generationKey = (generation: string) => 'analysis:g:' + generation;
export const dailyKey = (day: string) => 'analysis:d:' + day;
export const shardKey = (generation: string, target: Target, index: number) => 'analysis:s:' + generation + ':' + target + ':' + index;
export const hashPayload = (json: string) => createHash('sha256').update(json).digest('hex');

type Header = Omit<AnalysisBuild, Target>;
type Shard = { hash: string; bytes: number; records: number };
export type AnalysisManifest = { version: typeof ANALYSIS_VERSION; header: Header; targets: Record<Target, Shard[]> };
export type AnalysisShard = { id: string; json: string };

export function makeAnalysisManifest(build: AnalysisBuild) {
  const { metadata, inventoryValue, categories, referenceExclusions } = build;
  if (!isAnalysisGeneration(metadata.generation) || metadata.generation !== metadata.asOf ||
      metadata.coverageEnd !== jstDay(metadata.asOf) || inventoryValue.asOf !== metadata.asOf) throw new Error('ANALYSIS_BUILD_GENERATION');
  const targets = {} as AnalysisManifest['targets'];
  const manifest: AnalysisManifest = { version: ANALYSIS_VERSION, header: { metadata, inventoryValue, categories, referenceExclusions }, targets };
  const shards: AnalysisShard[] = [];
  for (const target of ANALYSIS_TARGETS) {
    const entries: Shard[] = [];
    targets[target] = entries;
    let parts: string[] = [];
    let bytes = 2;
    let targetBytes = 0;
    function flush() {
      if (!parts.length) return;
      targetBytes += bytes;
      if (targetBytes > ANALYSIS_MAX_TARGET_BYTES || shards.length >= ANALYSIS_MAX_SHARDS) throw new Error('ANALYSIS_SHARD_LIMIT');
      const json = '[' + parts.join(',') + ']';
      shards.push({ id: shardKey(metadata.generation, target, entries.length), json });
      entries.push({ hash: hashPayload(json), bytes, records: parts.length });
      parts = [];
      bytes = 2;
    }
    for (const fact of build[target]) {
      const json = JSON.stringify(fact);
      const size = Buffer.byteLength(json);
      if (size + 2 > ANALYSIS_SHARD_BYTES) throw new Error('ANALYSIS_FACT_TOO_LARGE');
      if (bytes + size + Number(parts.length > 0) > ANALYSIS_SHARD_BYTES) flush();
      bytes += size + Number(parts.length > 0);
      parts.push(json);
    }
    flush();
  }
  const dailyManifest: AnalysisManifest = {
    ...manifest,
    targets: { inventory: targets.inventory, sales: [], acquisitions: [], retailReference: [] },
  };
  return { manifest, shards, dailyManifest };
}

export function parseAnalysisManifest(json: unknown, generation: string): AnalysisManifest {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 380 * 1024) throw new Error('ANALYSIS_MANIFEST_INVALID');
  const manifest = JSON.parse(json) as AnalysisManifest;
  const meta = manifest?.header?.metadata;
  if (manifest?.version !== ANALYSIS_VERSION || meta?.version !== ANALYSIS_VERSION ||
      !isAnalysisGeneration(generation) || meta.generation !== generation || meta.asOf !== generation ||
      meta.coverageEnd !== jstDay(generation) || dateOnly(meta.coverageStart) > meta.coverageEnd ||
      meta.timezone !== 'Asia/Tokyo' || !Array.isArray(manifest.header.categories) || manifest.header.categories.length > 100 ||
      !manifest.header.referenceExclusions || manifest.header.inventoryValue?.asOf !== generation) throw new Error('ANALYSIS_MANIFEST_INVALID');
  parseInventoryValue(JSON.stringify(manifest.header.inventoryValue));
  if(meta.accuracy!=='captured-current-source'&&meta.accuracy!=='reference-reconstructed')throw new Error('ANALYSIS_MANIFEST_INVALID');
  if(meta.accuracy==='reference-reconstructed'){
    const h=meta.inventoryHistory,integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
    if(!h||h.basis!=='archived-source'||h.sourceSystem!=='ZAICO'||h.sourceCapturedAt!==generation||
      !isAnalysisGeneration(h.reconstructedAt)||h.reconstructedAt<generation||!/^[a-f\d]{64}$/.test(h.sourceKeyDigest)||
      h.skuBasis!=='historical-baseline-and-immutable-link'||!integer(h.sourceRecordCount)||!integer(h.unmatchedSourceRecords)||
      !integer(h.historicalIdentityRecords)||!integer(h.currentIdentityRecords)||!integer(h.unknownQuantityRecords)||
      h.historicalIdentityRecords+h.currentIdentityRecords+h.unmatchedSourceRecords!==h.sourceRecordCount||
      h.unknownQuantityRecords>h.sourceRecordCount||!Array.isArray(h.limitations)||!h.limitations.length||h.limitations.length>10||
      h.limitations.some(value=>typeof value!=='string'||!value.length||value.length>500))throw new Error('ANALYSIS_HISTORY_PROVENANCE_INVALID');
  }
  let shardCount = 0;
  for (const target of ANALYSIS_TARGETS) {
    const entries = manifest.targets?.[target];
    if (!Array.isArray(entries)) throw new Error('ANALYSIS_MANIFEST_INVALID');
    shardCount += entries.length;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry || !/^[a-f\d]{64}$/.test(entry.hash) || !Number.isInteger(entry.bytes) ||
          entry.bytes < 3 || entry.bytes > ANALYSIS_SHARD_BYTES || !Number.isInteger(entry.records) ||
          entry.records < 1 || entry.records > entry.bytes) throw new Error('ANALYSIS_MANIFEST_INVALID');
      bytes += entry.bytes;
    }
    if (bytes > ANALYSIS_MAX_TARGET_BYTES) throw new Error('ANALYSIS_MANIFEST_INVALID');
  }
  if (shardCount > ANALYSIS_MAX_SHARDS) throw new Error('ANALYSIS_MANIFEST_INVALID');
  return manifest;
}

export function parseAnalysisShard(json: unknown, descriptor: Shard): Fact[] {
  if (typeof json !== 'string' || Buffer.byteLength(json) !== descriptor.bytes ||
      hashPayload(json) !== descriptor.hash) throw new Error('ANALYSIS_SHARD_INCOMPLETE');
  const parsed = JSON.parse(json) as Fact[];
  if (!Array.isArray(parsed) || parsed.length !== descriptor.records) throw new Error('ANALYSIS_SHARD_INCOMPLETE');
  return parsed;
}

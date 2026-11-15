import { Sha256 } from '@aws-crypto/sha256-js';
import { CATEGORY_COLORS } from './categoryFromTitle';
import { withCurrentHoldingCounts } from './holdings';
import { positive } from './normalize';
import { dateOnly, monthPeriod, requestedPeriod, rollingPeriod } from './period';
import { currentSkus, isSkuDimension, isSkuGroupKey, skuDimensionKey, type CurrentSku } from './skus';
import { UNKNOWN, type AnalysisBuild, type AnalysisRequest, type AnalysisResult, type Bucket, type DetailItem, type DetailRecord, type DetailResult, type Dimension, type DrilldownRequest, type Fact, type Period, type SkuDimension, type Summary, type Target, type Totals, type UnknownCounts } from './types';

type RecordDimension = Exclude<Dimension, SkuDimension>;
const dimensions: Record<Target, readonly RecordDimension[]> = {
  inventory: ['category', 'holding', 'holdingBand', 'holdingCount'],
  sales: ['category', 'lot', 'lotBand'],
  acquisitions: ['category', 'lot', 'lotBand'],
  retailReference: ['category', 'lot', 'lotBand'],
};

const classLabels: Record<string, string> = { single: '単品仕入れ', multiple: '複数仕入れ', unknown: '判定不明' };
const holdingLabels: Record<string, string> = { single: '1点だけ保有', multiple: '2点以上保有', unknown: '判定不明' };
const bandLabels: Record<string, string> = { '1': '1点', '2-3': '2〜3点', '4-8': '4〜8点', '9+': '9点以上', unknown: '判定不明' };
const colors = ['#2f6659', '#b78243', '#6b83aa', '#a06975', '#788448', '#548e9b', '#8a75a4', '#b46e4e', '#9b9355', '#497f76', '#767584'];
const holdingCountColors = [
  '#244d48', '#58958d', '#ae794f', '#8a749b', '#b9a255', '#547a98', '#849358', '#bd8591', '#9a5949',
  '#416d78', '#8a783d', '#527868', '#a771ac', '#aa635e', '#517cae', '#a78b53', '#698d73', '#77616e',
];

function dimensionColor(dimension: Dimension, key: string): string {
  if (key === UNKNOWN || key === 'unknown') return '#a2a7a5';
  if ((dimension === 'category' || dimension === 'skuCategory') && Object.hasOwn(CATEGORY_COLORS, key)) return CATEGORY_COLORS[key];
  if (dimension === 'holdingCount' || dimension === 'skuHoldingCount') return holdingCountColors[(Number(key) - 1) % holdingCountColors.length];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(31, hash) + key.charCodeAt(i)) >>> 0;
  return colors[hash % colors.length];
}

function unknownCounts(): UnknownCounts {
  return { amount: 0, cost: 0, quantity: 0, category: 0, kind: 0, lot: 0, channel: 0, origin: 0, date: 0 };
}

function sum(a: number, b: number): number {
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw new Error('ANALYSIS_TOTAL_OVERFLOW');
  return total;
}

function totals(facts: readonly Fact[]): Totals {
  const kinds = new Set<string>();
  const lots = new Set<string>();
  const result: Totals = {
    amount: 0, gross: 0, returns: 0, quantity: 0, grossQuantity: 0, returnedQuantity: 0,
    kinds: 0, lots: 0, records: facts.length, unknown: unknownCounts(),
  };
  for (const fact of facts) {
    const amount = fact.amount ?? 0;
    if (amount < 0) result.returns = sum(result.returns, -amount);
    else result.gross = sum(result.gross, amount);
    const quantity = fact.quantity ?? 0;
    if (quantity < 0) result.returnedQuantity = sum(result.returnedQuantity, -quantity);
    else result.grossQuantity = sum(result.grossQuantity, quantity);
    if (fact.kindId && fact.kindCount) kinds.add(fact.kindId);
    if (fact.lotId && fact.lotCount) lots.add(fact.lotId);
    for (const key of Object.keys(result.unknown) as (keyof UnknownCounts)[]) {
      result.unknown[key] = sum(result.unknown[key], fact.unknown[key]);
    }
  }
  result.amount = sum(result.gross, -result.returns);
  result.quantity = sum(result.grossQuantity, -result.returnedQuantity);
  result.kinds = kinds.size;
  result.lots = lots.size;
  return result;
}

function labels(build: AnalysisBuild, dimension: Dimension): ReadonlyMap<string, string> {
  if (dimension === 'category' || dimension === 'skuCategory') {
    return new Map([...build.categories.map(category => [category.id, category.label] as const), [UNKNOWN, '未分類']]);
  }
  const entries = dimension === 'holding' ? holdingLabels : dimension === 'lot' ? classLabels : bandLabels;
  return new Map(Object.entries(entries));
}

function dimensionKey(fact: Fact, dimension: RecordDimension): string {
  if (dimension !== 'holdingCount') return fact[dimension];
  return fact.holdingCount == null ? UNKNOWN : String(fact.holdingCount);
}

function holdingCountLabels(keys: Iterable<string>): ReadonlyMap<string, string> {
  const counts = [...keys].filter(key => key !== UNKNOWN).sort((a, b) => Number(a) - Number(b));
  return new Map([...counts.map(key => [key, key + '点保有'] as const), [UNKNOWN, '保有数不明']]);
}

function validDimensionKey(build: AnalysisBuild, dimension: Dimension, key: string): boolean {
  if (dimension !== 'holdingCount' && dimension !== 'skuHoldingCount') return labels(build, dimension).has(key);
  return key === UNKNOWN || (positive(Number(key)) !== null && String(Number(key)) === key);
}

function skuBuckets(build: AnalysisBuild, groups: readonly CurrentSku[], dimension: SkuDimension): Bucket[] {
  const grouped = new Map<string, { records: Fact[]; skus: number }>();
  for (const group of groups) {
    const key = skuDimensionKey(group, dimension);
    const bucket = grouped.get(key) ?? { records: [], skus: 0 };
    for (const record of group.records) bucket.records.push(record);
    bucket.skus++;
    grouped.set(key, bucket);
  }
  const names = dimension === 'skuHoldingCount' ? holdingCountLabels(grouped.keys()) : labels(build, dimension);
  const buckets: Bucket[] = [];
  for (const [key, label] of names) {
    const bucket = grouped.get(key);
    if (bucket) buckets.push({ key, label, color: dimensionColor(dimension, key), ...totals(bucket.records), skus: bucket.skus });
  }
  if (buckets.length !== grouped.size) throw new Error('UNKNOWN_ANALYSIS_SKU_BUCKET');
  return buckets;
}

function summarize(build: AnalysisBuild, target: Target, facts: readonly Fact[]): Summary {
  const result: Summary = { ...totals(facts), dimensions: {} };
  for (const dimension of dimensions[target]) {
    const grouped = new Map<string, Fact[]>();
    for (const fact of facts) {
      const key = dimensionKey(fact, dimension);
      const members = grouped.get(key) ?? [];
      members.push(fact);
      grouped.set(key, members);
    }
    const names = dimension === 'holdingCount' ? holdingCountLabels(grouped.keys()) : labels(build, dimension);
    const buckets: Bucket[] = [];
    for (const [key, label] of names) {
      const members = grouped.get(key);
      if (members) buckets.push({ key, label, color: dimensionColor(dimension, key), ...totals(members) });
    }
    if (buckets.reduce((count, bucket) => count + bucket.records, 0) !== facts.length) throw new Error('UNKNOWN_ANALYSIS_BUCKET');
    result.dimensions[dimension] = buckets;
  }
  if (target === 'inventory' && build.metadata.inventorySkuVersion === 1) {
    const { groups, unknownSkuRecords } = currentSkus(facts);
    result.skus = groups.length;
    result.unknownSkuRecords = unknownSkuRecords;
    result.dimensions.skuCategory = skuBuckets(build, groups, 'skuCategory');
    result.dimensions.skuHoldingCount = skuBuckets(build, groups, 'skuHoldingCount');
  }
  return result;
}

type Selection =
  | { status: 'ok'; period: Period | null; facts: Fact[] }
  | { status: 'missing' | 'error' | 'expired' };

function select(build: AnalysisBuild, request: AnalysisRequest): Selection {
  const { target, start, end } = request;
  const { asOf, coverageStart, coverageEnd, generation } = build.metadata;
  if (request.generation && request.generation !== generation) return { status: 'expired' };
  if (!Object.hasOwn(dimensions, target)) return { status: 'error' };
  if (request.rollingDays !== undefined && (request.rollingDays !== 30 || target !== 'sales' || start !== undefined || end !== undefined || request.daily !== undefined)) return { status: 'error' };
  if (request.daily) {
    const day = dateOnly(request.daily);
    if (target !== 'inventory' || start || end) return { status: 'error' };
    if (day !== coverageEnd) return { status: 'missing' };
  }
  if (target === 'inventory') {
    if (start || end) return { status: 'error' };
    return { status: 'ok', period: null, facts: withCurrentHoldingCounts(build.inventory) };
  }

  let period: Period;
  if (target === 'sales') {
    if ((start === undefined) !== (end === undefined)) return { status: 'error' };
    period = request.rollingDays === 30 ? rollingPeriod(asOf, 30) : start !== undefined && end !== undefined
      ? requestedPeriod(start, end, asOf)
      : monthPeriod(coverageEnd.slice(0, 7), asOf);
    if (period.start < coverageStart || period.start > coverageEnd) return { status: 'missing' };
    if (period.end > coverageEnd) {
      const currentMonth = monthPeriod(coverageEnd.slice(0, 7), asOf);
      if (period.start !== currentMonth.start || period.end !== currentMonth.end) return { status: 'missing' };
    }
  } else {
    period = rollingPeriod(asOf, target === 'acquisitions' ? 30 : 90);
    if (coverageEnd < period.end || (start !== undefined && end === undefined) || (start === undefined && end !== undefined)) return { status: 'missing' };
    if ((start !== undefined && start !== period.start) || (end !== undefined && end !== period.end)) return { status: 'missing' };
  }
  return {
    status: 'ok', period,
    facts: build[target].filter(fact => fact.date !== null && fact.date >= period.start && fact.date <= period.end),
  };
}

export function queryAnalysis(build: AnalysisBuild, request: AnalysisRequest): AnalysisResult {
  try {
    const selected = select(build, request);
    if (selected.status !== 'ok') return selected;
    return {
      status: 'ok', target: request.target, metadata: build.metadata, period: selected.period,
      summary: summarize(build, request.target, selected.facts),
      inventoryValue: build.inventoryValue, referenceExclusions: build.referenceExclusions,
    };
  } catch {
    return { status: 'error' };
  }
}

function detailRecord(fact: Fact, categoryLabels: ReadonlyMap<string, string>): DetailRecord {
  return { ...fact, categoryLabel: categoryLabels.get(fact.category) ?? '未分類' };
}

function compare(a: Fact, b: Fact): number {
  const aDate = a.date ?? '';
  const bDate = b.date ?? '';
  if (aDate !== bDate) return aDate > bDate ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

function representative(item: DetailItem): DetailRecord {
  return item.type === 'record' ? item.record : item.group.representative;
}

function detailItems(facts: Fact[], categoryLabels: ReadonlyMap<string, string>, group: boolean): DetailItem[] {
  const items: DetailItem[] = [];
  const kinds = new Map<string, Fact[]>();
  for (const fact of facts.sort(compare)) {
    if (!group || !fact.kindId) {
      items.push({ type: 'record', record: detailRecord(fact, categoryLabels) });
      continue;
    }
    const members = kinds.get(fact.kindId) ?? [];
    members.push(fact);
    kinds.set(fact.kindId, members);
  }
  for (const [kindId, members] of kinds) {
    const { amount, quantity, unknown } = totals(members);
    items.push({ type: 'group', group: {
      kindId, representative: detailRecord(members[0], categoryLabels), count: members.length,
      amount: unknown.amount > 0 ? null : amount, quantity: unknown.quantity > 0 ? null : quantity,
    } });
  }
  return items.sort((a, b) => compare(representative(a), representative(b)));
}

function skuDetailItems(groups: readonly CurrentSku[], categoryLabels: ReadonlyMap<string, string>, generation: string, showMembers: boolean): DetailItem[] {
  const items: DetailItem[] = [];
  for (const { sku, category, records } of groups) {
    if (showMembers || records.length === 1) {
      for (const record of records) items.push({ type: 'record', record: detailRecord(record, categoryLabels) });
      continue;
    }
    const sorted = [...records].sort(compare);
    const { amount, quantity, unknown } = totals(sorted);
    const sample = sorted[0];
    const basis = category === UNKNOWN ? 'unknown' : sorted.some(record => record.category === category && record.categoryBasis === 'confirmed') ? 'confirmed' : 'title';
    const record = detailRecord({ ...sample, category, categoryBasis: basis }, categoryLabels);
    items.push({ type: 'sku-group', group: {
      sku, groupKey: publicHandle('bello-analysis-sku', sku, generation), representative: record, count: records.length,
      amount: unknown.amount > 0 ? null : amount, quantity: unknown.quantity > 0 ? null : quantity,
    } });
  }
  return items.sort((a, b) => compare(representative(a), representative(b)));
}

function publicHandle(namespace: 'bello-analysis-lot' | 'bello-analysis-sku', id: string, generation: string): string {
  const hash = new Sha256();
  hash.update(JSON.stringify([namespace, generation, id]));
  return Array.from(hash.digestSync(), byte => byte.toString(16).padStart(2, '0')).join('');
}

function publicDetailItem(item: DetailItem, target: Target, generation: string): DetailItem {
  const record = representative(item);
  const publicRecord = {
    ...record,
    id: target === 'acquisitions' ? publicHandle('bello-analysis-lot', record.id, generation) : record.id,
    lotId: record.lotId ? publicHandle('bello-analysis-lot', record.lotId, generation) : null,
  };
  if (item.type === 'record') return { type: 'record', record: publicRecord };
  if (item.type === 'sku-group') return { type: 'sku-group', group: { ...item.group, representative: publicRecord } };
  return { type: 'group', group: { ...item.group, representative: publicRecord } };
}

export function drilldownAnalysis(build: AnalysisBuild, request: DrilldownRequest): DetailResult {
  try {
    if (typeof request.generation !== 'string' || !request.generation) return { status: 'error' };
    const selected = select(build, request);
    if (selected.status !== 'ok') return selected;
    const { target, dimension, key, groupKindId, groupSku, daily, cursor } = request;
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { status: 'error' };
    if ((dimension === undefined) !== (key === undefined)) return { status: 'error' };
    const skuDimension = isSkuDimension(dimension) ? dimension : undefined;
    const recordDimension = isSkuDimension(dimension) ? undefined : dimension;
    if (skuDimension && target !== 'inventory') return { status: 'error' };
    if (recordDimension && !dimensions[target].includes(recordDimension)) return { status: 'error' };
    if (dimension && !validDimensionKey(build, dimension, key!)) return { status: 'error' };
    if (groupKindId && (skuDimension || (target !== 'inventory' && target !== 'acquisitions'))) return { status: 'error' };
    if (groupSku !== undefined && (!skuDimension || !isSkuGroupKey(groupSku))) return { status: 'error' };
    if (skuDimension && build.metadata.inventorySkuVersion !== 1) return { status: 'missing' };

    const signature = JSON.stringify([request.generation, target, selected.period?.start, selected.period?.end, daily, dimension, key, groupKindId,
      ...(skuDimension ? [groupSku] : [])]);
    let offset = 0;
    if (cursor !== undefined) {
      if (cursor.length > 3000) return { status: 'error' };
      const parsed: unknown = JSON.parse(decodeURIComponent(cursor));
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== signature || !Number.isSafeInteger(parsed[1]) || parsed[1] < 1) return { status: 'error' };
      offset = parsed[1];
    }
    const categoryLabels = labels(build, 'category');
    let items: DetailItem[];
    if (skuDimension) {
      const { groups } = currentSkus(selected.facts);
      const filtered = groups.filter(group => skuDimensionKey(group, skuDimension) === key &&
        (!groupSku || (group.records.length > 1 && publicHandle('bello-analysis-sku', group.sku, request.generation) === groupSku)));
      items = skuDetailItems(filtered, categoryLabels, request.generation, groupSku !== undefined);
    } else {
      const filtered = selected.facts.filter(fact => (!recordDimension || dimensionKey(fact, recordDimension) === key) && (!groupKindId || fact.kindId === groupKindId));
      items = detailItems(filtered, categoryLabels, !groupKindId && (target === 'inventory' || target === 'acquisitions'));
    }
    if (offset > 0 && offset >= items.length) return { status: 'error' };
    const next = offset + limit;
    return {
      status: 'ok', items: items.slice(offset, next).map(item => publicDetailItem(item, target, request.generation)),
      nextCursor: next < items.length ? encodeURIComponent(JSON.stringify([signature, next])) : null,
    };
  } catch {
    return { status: 'error' };
  }
}


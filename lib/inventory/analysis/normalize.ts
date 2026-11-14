import { parseCustomFields } from '../customFieldsCodecCore';
import { effectiveListThumbnailKey, normalizeImageRecord, resolveTopImage, type RawInventoryImage } from '../imageTypes';
import { procurementPurchasePrice } from '../../procurement/pricing';
import { sourceDay } from './period';
import { UNKNOWN, type AcquisitionLot, type AnalysisSource, type Band, type Evidence, type MetadataRow, type ProductCategory } from './types';

type Fields = Record<string, unknown>;

export function fields(value: unknown): Fields | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value : null;
}

export function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function nonnegative(value: unknown): number | null {
  const number = integer(value);
  return number !== null && number >= 0 ? number : null;
}

export function positive(value: unknown): number | null {
  const number = integer(value);
  return number !== null && number > 0 ? number : null;
}

export function hasEvidence(value: Evidence | null | undefined): boolean {
  return !!(text(value?.source) && text(value?.recordId));
}

export function sourceKey(source: string, sourceRecordId: string): string {
  return encodeURIComponent(source) + ':' + encodeURIComponent(sourceRecordId);
}

export function quantityBand(quantity: number | null): Band {
  if (quantity === null || quantity < 1) return 'unknown';
  if (quantity === 1) return '1';
  if (quantity <= 3) return '2-3';
  if (quantity <= 8) return '4-8';
  return '9+';
}

export function quantityClass(quantity: number | null): 'single' | 'multiple' | 'unknown' {
  const band = quantityBand(quantity);
  return band === 'unknown' ? 'unknown' : band === '1' ? 'single' : 'multiple';
}

export function productCategories(rows: readonly MetadataRow[]) {
  const taxonomy = rows.filter(row => row.value.type === 'taxonomy');
  if (taxonomy.length > 1) throw new Error('DUPLICATE_ANALYSIS_TAXONOMY');
  const value = taxonomy[0]?.value;
  const byId = new Map<string, ProductCategory>();
  if (value?.type === 'taxonomy') {
    for (const category of value.categories) {
      if (!text(category.id) || !text(category.label) || category.id === UNKNOWN || byId.has(category.id)) {
        throw new Error('INVALID_ANALYSIS_CATEGORY');
      }
      byId.set(category.id, category);
    }
  }
  const canonical = new Map<string, string>();
  for (const category of byId.values()) {
    const path = new Set<string>();
    let current = category;
    while (current.mergedInto) {
      if (path.has(current.id)) throw new Error('CYCLIC_ANALYSIS_CATEGORY');
      path.add(current.id);
      const next = byId.get(current.mergedInto);
      if (!next) throw new Error('MISSING_ANALYSIS_CATEGORY');
      current = next;
    }
    canonical.set(category.id, current.id);
  }
  return {
    categories: [...byId.values()].filter(category => !category.mergedInto),
    canonical: (id: string | null | undefined) => canonical.get(id ?? '') ?? UNKNOWN,
  };
}

export function readSources(rows: readonly AnalysisSource[]) {
  const byId = new Map<string, AnalysisSource>();
  const custom = new Map<string, Fields>();
  const parents = new Map<string, string | null>();
  const mutations = new Map<string, string[]>();
  for (const row of rows) {
    if (byId.has(row.id)) throw new Error('DUPLICATE_ANALYSIS_INVENTORY');
    byId.set(row.id, row);
    const payload = parseCustomFields(row.customFields) ?? {};
    custom.set(row.id, payload);
    if (!Object.hasOwn(payload, '__belloStockSplit')) continue;
    const split = fields(payload.__belloStockSplit);
    const parent = text(split?.sourceInventoryId);
    const mutation = text(split?.mutationId);
    if (!parent || !mutation || (split?.operation !== 'STOCK_SPLIT' && split?.operation !== 'SOLD_OUT')) {
      parents.set(row.id, null);
      continue;
    }
    parents.set(row.id, parent);
    const key = JSON.stringify([parent, split.operation, mutation]);
    const siblings = mutations.get(key) ?? [];
    siblings.push(row.id);
    mutations.set(key, siblings);
  }
  for (const siblings of mutations.values()) {
    if (siblings.length > 1) siblings.forEach(id => parents.set(id, null));
  }

  const roots = new Map<string, string | null>();
  for (const id of byId.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && byId.has(current) && !roots.has(current) && !path.has(current)) {
      path.add(current);
      if (!parents.has(current)) break;
      current = parents.get(current) ?? null;
    }
    const root = current !== null && byId.has(current)
      ? roots.get(current) ?? (parents.has(current) ? null : current)
      : null;
    for (const member of path) roots.set(member, root);
  }
  return { byId, custom, roots };
}

function rawImage(value: unknown): value is RawInventoryImage {
  const image = fields(value);
  return typeof image?.storageKey === 'string' && typeof image.sortOrder === 'number';
}

function inventoryImageKey(value: string): boolean {
  return value.startsWith('inventory/') && !value.includes('..') && value.length <= 1024;
}

export function imageReference(row: AnalysisSource): string | null {
  if (!Array.isArray(row.images)) return null;
  const top = resolveTopImage(row.images.filter(rawImage).map(normalizeImageRecord));
  if (!top) return null;
  const key = effectiveListThumbnailKey(top);
  if (typeof key === 'string' && inventoryImageKey(key)) return key;
  return inventoryImageKey(top.storageKey) ? top.storageKey : null;
}

export interface ImportedLot extends AcquisitionLot {
  sourceDate: string;
}

function restageCost(record: Fields, quantity: number | null): number | null {
  const hammerPrice = positive(record.hammerPrice);
  if (!hammerPrice || !quantity || typeof record.isBundle !== 'boolean') return null;
  const hammerTotal = record.isBundle ? hammerPrice : hammerPrice * quantity;
  if (!Number.isSafeInteger(hammerTotal)) return null;
  try { return procurementPurchasePrice('RESTAGE', hammerTotal); }
  catch { return null; }
}

export function importedLot(row: AnalysisSource, custom: Fields, asOf: string): ImportedLot | null {
  const records = [
    ['RESTAGE', fields(custom.__restageImport)],
    ['YAHOO_PURCHASE', fields(custom.__yahooPurchaseImport)],
    ['TREFAC', fields(custom.__trefacImport)],
  ] as const;
  const matching = records.filter(([, record]) => record !== null);
  if (matching.length !== 1) return null;
  const [provider, entry] = matching[0];
  const record = entry!;
  const id = text(provider === 'YAHOO_PURCHASE' ? record.auctionId : record.goodsId);
  const account = text(record.account);
  const sourceDate = (provider === 'TREFAC' ? text(record.soldAt) : null) ?? text(record.date) ?? row.transactionDate;
  const date = sourceDay(sourceDate, asOf);
  if (!id || !sourceDate || !date || (provider === 'TREFAC' && !account)) return null;

  const source = provider === 'TREFAC' ? 'TREFAC#' + account : provider;
  const sourceRecordId = provider === 'RESTAGE' ? date + '#' + id : id;
  const quantity = positive(record.quantity);
  const itemTotal = nonnegative(record.itemTotal);
  const shipping = nonnegative(record.shipping);
  const yahooCost = itemTotal !== null && shipping !== null ? nonnegative(itemTotal + shipping) : null;
  const costTotal = provider === 'RESTAGE' ? restageCost(record, quantity)
    : provider === 'TREFAC' ? nonnegative(record.purchaseTotal) : yahooCost;
  return {
    type: 'lot', id: sourceKey(source, sourceRecordId), source, sourceRecordId, state: 'confirmed',
    date, sourceDate, quantity, costTotal, categoryId: null, kindId: null, merchandise: true,
    operation: 'acquisition', originalLotId: null,
  };
}


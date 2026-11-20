import { inventoryCategoryIds } from '../categories';
import { effectiveHeroKey, normalizeImageRecord, resolveTopImage, splitImagesByType, type InventoryImageRecord, type RawInventoryImage } from '../imageTypes';
import type { CatalogStage, PublicCatalogItem } from './types';

export type Row = Record<string, unknown>;
export const STAGES = [
  { name: '補修待ち', stage: 'repair' },
  { name: '撮影待ち', stage: 'photo' },
  { name: '出品待ち', stage: 'listing' },
] as const;
export type CatalogCategories = { stages: Map<string, CatalogStage>; excluded: Set<string> };
export const validInventoryId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
export const validToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
export const validStorageKey = (key: unknown): key is string => typeof key === 'string' && key.startsWith('inventory/') && key.length < 1024 && !key.includes('..') && !/[\\\u0000-\u001f\u007f]/.test(key);

export function catalogCategories(rows: Row[]): CatalogCategories {
  const stages = new Map<string, CatalogStage>();
  const excluded = new Set<string>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.name !== 'string') continue;
    // A conflicting sold category always wins, including an inactive master.
    if (['売り切れ', '売却済み', '売却済', '販売済み', '販売済', '削除済み', '合算済み'].includes(row.name)) excluded.add(row.id);
    if (row.isActive === false || row.deletedAt) continue;
    const stage = STAGES.find(stage => stage.name === row.name);
    if (stage) stages.set(row.id, stage.stage);
  }
  return { stages, excluded };
}

export function eligibleStage(row: Row, categories: CatalogCategories): CatalogStage | null {
  if (!validInventoryId(row.id) || row.deletedAt || row.isDeleted || row.mergedIntoId || row.mergedIntoInventoryId || row.listingPartition === 'MERGED'
      || row.saleEndDate || row.soldAt || row.outboundBatchId || row.outboundArrivalBatchId
      || typeof row.quantity !== 'number' || !Number.isSafeInteger(row.quantity) || row.quantity <= 0) return null;
  const ids = inventoryCategoryIds(row);
  if (ids.some(id => categories.excluded.has(id))) return null;
  // Stable precedence when an item carries more than one eligible category.
  for (const stage of STAGES) if (ids.some(id => categories.stages.get(id) === stage.stage)) return stage.stage;
  return null;
}

export function catalogPhotos(row: Row): InventoryImageRecord[] {
  if (!Array.isArray(row.images)) return [];
  const images = row.images.filter((image): image is RawInventoryImage => image !== null && typeof image === 'object'
    && validStorageKey(image.storageKey) && typeof image.sortOrder === 'number' && Number.isFinite(image.sortOrder)).map(normalizeImageRecord);
  const normal = splitImagesByType(images).normal;
  const top = resolveTopImage(normal);
  return top ? [top, ...normal.filter(image => image !== top)].slice(0, 20) : [];
}

/** Strip leading operational annotations; free-text notes are never copied. */
export function publicProductName(name: unknown): string {
  if (typeof name !== 'string') return '商品';
  return name.replace(/^(?:\s*(?:【[^】]*】|\[[^\]]*\]|［[^］]*］|\([^)]*\)|（[^）]*）))+\s*/u, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) || '商品';
}
const dimension = (value: unknown): string | null => typeof value === 'string' && value.length <= 50
  && /^[\d０-９\s.,，．〜～~\-+＋−±×xX/／約φΦ直径幅奥行高さcmｍm㎝㎜()（）]+$/u.test(value) ? value.trim() || null : null;

export function publicCatalogItem(row: Row, categories: CatalogCategories, token: string): PublicCatalogItem | null {
  const stage = eligibleStage(row, categories);
  if (!stage) return null;
  const images = catalogPhotos(row).map((_, index) => `/api/shared-inventory/${token}/image/${row.id}?index=${index}`);
  return {
    id: String(row.id), name: publicProductName(row.name),
    managementNumber: typeof row.sku === 'string' ? row.sku.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : '',
    quantity: row.quantity as number,
    dimensions: { width: dimension(row.width), depth: dimension(row.depth), height: dimension(row.height) },
    stage, stageLabel: STAGES.find(entry => entry.stage === stage)!.name,
    imageUrl: images[0] ?? null, images,
  };
}

export function catalogImageKey(row: Row, index: number): string | null {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 20) return null;
  const photo = catalogPhotos(row)[index];
  if (!photo) return null;
  const key = effectiveHeroKey(photo);
  return validStorageKey(key) ? key : null;
}

import 'server-only';
import { inventoryAuthMode, serverDataClient } from '../amplify/dataClient';
import { effectiveListThumbnailKey, normalizeImageRecord, resolveTopImage } from './imageTypes';
import type { InventoryListRow } from './queries';
import { inventoryVerifiedReadSession } from './mutationSession';
import { inventoryDdb, inventoryTable } from './categoryPersistence';
import { readInventoryBatch } from './batchRead';

export type ThumbnailRecord = Pick<InventoryListRow, 'id' | 'updatedAt' | 'mainImageStorageKey' | 'mainImageThumbnailKey' | 'mainImageIsPrimary'>;

/** Verified, projected reads; never fetch prices, customer or ledger data for thumbnails. */
export async function readThumbnailRecords(ids: string[]): Promise<ThumbnailRecord[]> {
  const unique = [...new Set(ids)];
  if (unique.length > 200 || unique.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw Error('INVALID_THUMBNAIL_IDS');
  // Keep the signature/role check before IAM, including direct callers. The
  // projection excludes prices, notes, customer information and ledger fields.
  if (await inventoryVerifiedReadSession()) {
    const rows = await readInventoryBatch(inventoryDdb, inventoryTable('Inventory'), unique, undefined,
      ['updatedAt', 'deletedAt', 'listingPartition', 'images']);
    return unique.flatMap(id => {
      const row = rows.get(id);
      if (!row || row.deletedAt || row.listingPartition === 'MERGED') return [];
      const top = resolveTopImage((Array.isArray(row.images) ? row.images : []).filter(Boolean).map(normalizeImageRecord));
      return [{id, updatedAt: String(row.updatedAt), mainImageStorageKey: top?.storageKey ?? null,
        mainImageThumbnailKey: top ? effectiveListThumbnailKey(top) : null, mainImageIsPrimary: top?.isPrimary === true}];
    });
  }
  const selectionSet = ['id', 'updatedAt', 'deletedAt', 'images.*'] as const;
  const rows = await Promise.all(unique.map(async id => {
    const { data, errors } = await serverDataClient.models.Inventory.get({ id }, { ...inventoryAuthMode, selectionSet });
    if (errors?.length) throw new Error('INVENTORY_THUMBNAILS_UNAVAILABLE');
    if (!data || data.deletedAt) return null;
    const images = (data.images ?? []).filter(image => image !== null).map(normalizeImageRecord);
    const top = resolveTopImage(images);
    return {
      id: data.id, updatedAt: data.updatedAt,
      mainImageStorageKey: top?.storageKey ?? null,
      mainImageThumbnailKey: top ? effectiveListThumbnailKey(top) : null,
      mainImageIsPrimary: top?.isPrimary === true,
    };
  }));
  return rows.filter((row): row is ThumbnailRecord => row !== null);
}

import 'server-only';
import { inventoryAuthMode, serverDataClient } from '../amplify/dataClient';
import { effectiveListThumbnailKey, normalizeImageRecord, resolveTopImage } from './imageTypes';
import type { InventoryListRow } from './queries';

export type ThumbnailRecord = Pick<InventoryListRow, 'id' | 'updatedAt' | 'mainImageStorageKey' | 'mainImageThumbnailKey' | 'mainImageIsPrimary'>;

/** Authenticated AppSync reads; never fetch prices, customer or ledger data for thumbnails. */
export async function readThumbnailRecords(ids: string[]): Promise<ThumbnailRecord[]> {
  const selectionSet = ['id', 'updatedAt', 'deletedAt', 'images.*'] as const;
  const rows = await Promise.all([...new Set(ids)].map(async id => {
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

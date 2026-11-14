import 'server-only';
import { getVerifiedInventoryAccess } from '@/lib/amplify/requireInventoryUser';
import { inventoryDdb, inventoryTable } from '../categoryPersistence';
import { inventoryVerifiedReadSession } from '../mutationSession';
import { isE2EFixtureModeActive } from '../e2eFixtures';
import { signInventoryListKey } from '../listImageUrls';
import { createAnalysisMetadataStore } from './metadata';
import { createAnalysisReader, loadAnalysis } from './reader';
import type { DetailItem, DetailRecord } from './types';

export const getAnalysisMetadataStore = () => createAnalysisMetadataStore(inventoryDdb, inventoryTable('InventoryAnalysisMetadata'));
export const analysisInventoryTable = () => inventoryTable('Inventory');

export async function getAnalysisAccess() {
  const access = await getVerifiedInventoryAccess();
  if (access.kind !== 'authorized') return null;
  if (isE2EFixtureModeActive()) return { role: access.role, owner: null };
  const session = await inventoryVerifiedReadSession();
  if (!session || !access.owner || session.owner !== access.owner || session.role !== access.role) return null;
  return session;
}

export function createAuthorizedAnalysisReader(owner?: string) {
  return createAnalysisReader({
    authorize: async () => {
      const access = await getAnalysisAccess();
      return access !== null && (owner === undefined || access.owner === owner);
    },
    load: request => {
      if (isE2EFixtureModeActive()) return Promise.resolve({ status: 'missing' });
      try {
        return loadAnalysis(inventoryDdb, inventoryTable('SalesAggregateSnapshot'), request);
      } catch {
        return Promise.resolve({ status: 'error' });
      }
    },
  });
}

async function signedRecord(record: DetailRecord): Promise<DetailRecord & { imageUrl: string | null }> {
  const imageUrl = record.imageRef ? await signInventoryListKey(record.imageRef, { cache: false }) : null;
  return { ...record, imageUrl };
}

export type SignedDetailItem =
  | (Extract<DetailItem, { type: 'record' }> & { record: Awaited<ReturnType<typeof signedRecord>> })
  | { type: 'group'; group: Extract<DetailItem, { type: 'group' }>['group'] & { representative: Awaited<ReturnType<typeof signedRecord>> } };

export async function signAnalysisItems(items: DetailItem[]): Promise<SignedDetailItem[]> {
  return Promise.all(items.map(async item => item.type === 'record'
    ? { type: 'record', record: await signedRecord(item.record) }
    : { type: 'group', group: { ...item.group, representative: await signedRecord(item.group.representative) } }));
}

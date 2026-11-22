import { reportFeatureError, observeFeatureOperation } from '@/lib/systemErrors/feature';
import { inspectAnalysisHealth } from '@/lib/systemErrors/health';
import { reportFeatureChecks } from '@/lib/systemErrors/healthReporting';
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
    load: async request => {
      if (isE2EFixtureModeActive()) return { status: 'missing' };
      const component = request.target === 'sales' ? 'sales-analysis' : 'inventory-analysis';
      let observedReadError = false;
      try {
        const result = await observeFeatureOperation(component, 'aggregate', () => loadAnalysis(inventoryDdb, inventoryTable('SalesAggregateSnapshot'), request, Date.now(), async error => {
          observedReadError = true;
          await reportFeatureError(error, component, 'aggregate');
        }), {reportFailure: false, successful: value => value.status === 'ok'});
        if (result.status === 'error' && !observedReadError) await reportFeatureError(undefined, component, 'aggregate');
        return result;
      } catch (error) {
        await reportFeatureError(error, component, 'aggregate');
        return { status: 'error' };
      }
    },
    onSummary: async (request, result) => {
      const component = request.target === 'sales' ? 'sales-analysis' : 'inventory-analysis';
      await reportFeatureChecks(component, 'aggregate', inspectAnalysisHealth(result));
    },
    onComputationError: async (request, error) => {
      await reportFeatureError(error, request.target === 'sales' ? 'sales-analysis' : 'inventory-analysis', 'aggregate');
    },
  });
}

async function signedRecord(record: DetailRecord): Promise<DetailRecord & { imageUrl: string | null }> {
  const imageUrl = record.imageRef ? await signInventoryListKey(record.imageRef, { cache: false }) : null;
  return { ...record, imageUrl };
}

export type SignedDetailItem =
  | (Extract<DetailItem, { type: 'record' }> & { record: Awaited<ReturnType<typeof signedRecord>> })
  | { type: 'group'; group: Extract<DetailItem, { type: 'group' }>['group'] & { representative: Awaited<ReturnType<typeof signedRecord>> } }
  | { type: 'sku-group'; group: Extract<DetailItem, { type: 'sku-group' }>['group'] & { representative: Awaited<ReturnType<typeof signedRecord>> } };

export async function signAnalysisItems(items: DetailItem[]): Promise<SignedDetailItem[]> {
  return Promise.all(items.map(async item => {
    if (item.type === 'record') return { type: 'record', record: await signedRecord(item.record) };
    const representative = await signedRecord(item.group.representative);
    if (item.type === 'group') return { type: 'group', group: { ...item.group, representative } };
    return { type: 'sku-group', group: { ...item.group, representative } };
  }));
}

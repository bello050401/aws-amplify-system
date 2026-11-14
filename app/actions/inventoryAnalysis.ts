'use server';

import { createAuthorizedAnalysisReader, getAnalysisAccess, getAnalysisMetadataStore, analysisInventoryTable, signAnalysisItems } from '@/lib/inventory/analysis/server';
import type { MetadataSaveRequest, MetadataSaveResult } from '@/lib/inventory/analysis/metadata';
import type { AnalysisRequest, DrilldownRequest } from '@/lib/inventory/analysis/types';
import { isE2EFixtureModeActive } from '@/lib/inventory/e2eFixtures';

export async function readInventoryAnalysis(request: AnalysisRequest) {
  return createAuthorizedAnalysisReader().summary(request);
}

export async function readInventoryAnalysisDetail(request: DrilldownRequest) {
  const result = await createAuthorizedAnalysisReader().detail(request);
  if (result.status !== 'ok') return result;
  return { ...result, items: await signAnalysisItems(result.items) };
}

export async function readInventoryAnalysisMetadata(inventoryId?: string) {
  try {
    const access = await getAnalysisAccess();
    if (!access || access.role !== 'ADMIN') return { status: 'error' as const };
    if (isE2EFixtureModeActive()) return { status: 'missing' as const };
    return await getAnalysisMetadataStore().inspect(inventoryId);
  } catch {
    return { status: 'error' as const };
  }
}

export async function listInventoryAnalysisMetadata(request: { type: 'kind' | 'lot'; cursor?: string }) {
  try {
    const access = await getAnalysisAccess();
    if (!access || access.role !== 'ADMIN' || isE2EFixtureModeActive()) return { status: 'error' as const };
    return await getAnalysisMetadataStore().list(request.type, request.cursor);
  } catch {
    return { status: 'error' as const };
  }
}

export async function saveInventoryAnalysisMetadata(request: MetadataSaveRequest): Promise<MetadataSaveResult> {
  try {
    const access = await getAnalysisAccess();
    if (!access || access.role !== 'ADMIN' || !access.owner || isE2EFixtureModeActive()) return { status: 'error' };
    return await getAnalysisMetadataStore().save(request, access.owner, analysisInventoryTable);
  } catch {
    return { status: 'error' };
  }
}

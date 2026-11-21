import { NextResponse } from 'next/server';
import { publicGrant } from '@/lib/inventory/partnerCatalog/grants';
import { MAX_CATALOG_SELECTED_ITEMS } from '@/lib/inventory/partnerCatalog/types';
import { catalogJsonBody, requireCatalogMutationOrigin } from '@/lib/inventory/partnerCatalog/request';
import { catalogFailure, catalogGrantStore, partnerCatalogServer, partnerCatalogResponseHeaders, requireCatalogAdmin } from '@/lib/inventory/partnerCatalog/server';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { ...partnerCatalogResponseHeaders, Vary: 'Cookie' };
export async function GET(request: Request) {
  try {
    await requireCatalogAdmin();
    const store = catalogGrantStore();
    const id = new URL(request.url).searchParams.get('id');
    await store.readGrant(id);
    const candidates = await partnerCatalogServer().candidates(requireCatalogAdmin);
    const grant = publicGrant(await store.readGrant(id));
    await requireCatalogAdmin();
    return NextResponse.json({ ok: true, grant, candidates, maxSelectedItems: MAX_CATALOG_SELECTED_ITEMS, checkedAt: new Date().toISOString() }, { headers });
  } catch (error) {
    const failure = catalogFailure(error);
    return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status, headers });
  }
}
export async function POST(request: Request) {
  try {
    const admin = await requireCatalogAdmin();
    requireCatalogMutationOrigin(request);
    const input = await catalogJsonBody(request);
    const service = partnerCatalogServer();
    const grant = await catalogGrantStore().saveSelection(input, admin.owner, async ids => {
      await service.validateSelection(ids);
      await requireCatalogAdmin();
    });
    return NextResponse.json({ ok: true, grant }, { headers });
  } catch (error) {
    const failure = catalogFailure(error);
    return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status, headers });
  }
}

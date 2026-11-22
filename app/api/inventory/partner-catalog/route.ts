import { reportFeatureError } from '@/lib/systemErrors/feature';
import { NextResponse } from 'next/server';
import { requireCatalogMutationOrigin } from '@/lib/inventory/partnerCatalog/request';
import { CatalogError } from '@/lib/inventory/partnerCatalog/grants';
import { catalogFailure, catalogGrantStore, partnerCatalogResponseHeaders, requireCatalogAdmin } from '@/lib/inventory/partnerCatalog/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { ...partnerCatalogResponseHeaders, Vary: 'Cookie' };
export async function GET() {
  try {
    await requireCatalogAdmin();
    return NextResponse.json({ ok: true, grants: await catalogGrantStore().list() }, { headers });
  } catch (error) {
    if (!(error instanceof CatalogError)) await reportFeatureError(error, 'partner-sharing', 'share');
    const failure = catalogFailure(error);
    return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status, headers });
  }
}
export async function POST(request: Request) {
  try {
    const admin = await requireCatalogAdmin();
    requireCatalogMutationOrigin(request);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new CatalogError(400, '入力内容を確認してください。');
    const body = await request.text();
    if (Buffer.byteLength(body) > 2048) throw new CatalogError(400, '入力内容が長すぎます。');
    let input: unknown;
    try { input = JSON.parse(body); } catch { throw new CatalogError(400, '入力内容を確認してください。'); }
    const grant = await catalogGrantStore().manage(input, admin.owner);
    const creating = input !== null && typeof input === 'object' && 'action' in input && input.action === 'create';
    return NextResponse.json({ ok: true, grant }, { status: creating ? 201 : 200, headers });
  } catch (error) {
    if (!(error instanceof CatalogError)) await reportFeatureError(error, 'partner-sharing', 'share');
    const failure = catalogFailure(error);
    return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status, headers });
  }
}

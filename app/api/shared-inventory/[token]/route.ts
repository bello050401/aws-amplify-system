import { reportFeatureError } from '@/lib/systemErrors/feature';
import { CatalogError } from '@/lib/inventory/partnerCatalog/grants';
import { NextResponse } from 'next/server';
import { catalogFailure, partnerCatalogResponseHeaders as headers, partnerCatalogServer } from '@/lib/inventory/partnerCatalog/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    return NextResponse.json(await partnerCatalogServer().read(token), { headers });
  } catch (error) {
    if (!(error instanceof CatalogError) || error.diagnostic === 'stored-grant-invalid') await reportFeatureError(error, 'partner-sharing', 'share');
    const failure = catalogFailure(error);
    return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status, headers });
  }
}

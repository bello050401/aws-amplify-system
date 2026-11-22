import { reportFeatureError } from '@/lib/systemErrors/feature';
import { catalogFailure, partnerCatalogServer, partnerCatalogResponseHeaders, requireCatalogAdmin } from '@/lib/inventory/partnerCatalog/server';
import { CatalogError } from '@/lib/inventory/partnerCatalog/grants';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { ...partnerCatalogResponseHeaders, Vary: 'Cookie' };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireCatalogAdmin();
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const rawIndex = params.get('index') ?? '0';
    if (params.getAll('index').length > 1 || !/^(?:0|[1-9][0-9]?)$/.test(rawIndex) || [...params.keys()].some(key => key !== 'index')) throw new CatalogError(404, '画像を表示できません。');
    const image = await partnerCatalogServer().adminImage(id, Number(rawIndex), requireCatalogAdmin);
    return new Response(image.bytes as BodyInit, { headers: { ...headers, 'Content-Type': image.contentType } });
  } catch (error) {
    if (!(error instanceof CatalogError)) await reportFeatureError(error, 'partner-sharing', 'share');
    const failure = catalogFailure(error);
    return Response.json({ ok: false, error: failure.error }, { status: failure.status, headers });
  }
}

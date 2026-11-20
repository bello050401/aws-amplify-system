import { NextResponse } from 'next/server';
import { CatalogError } from '@/lib/inventory/partnerCatalog/grants';
import { catalogFailure, partnerCatalogResponseHeaders as headers, partnerCatalogServer } from '@/lib/inventory/partnerCatalog/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ token: string; id: string }> }) {
  try {
    const { token, id } = await context.params;
    const params = new URL(request.url).searchParams;
    const raw = params.get('index') ?? '0';
    const size = params.get('size');
    if (!/^(0|[1-9]|1[0-9])$/.test(raw) || [...params.keys()].some(key => key !== 'index' && key !== 'size')
        || params.getAll('index').length > 1 || params.getAll('size').length > 1 || (size !== null && size !== 'full')) throw new CatalogError(404, '画像を表示できません。');
    const image = await partnerCatalogServer().image(token, id, Number(raw), size === 'full');
    return new Response(new Uint8Array(image.bytes), { headers: { ...headers, 'Content-Type': image.contentType, 'Content-Length': String(image.bytes.byteLength) } });
  } catch (error) {
    const failure = catalogFailure(error);
    return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status, headers });
  }
}

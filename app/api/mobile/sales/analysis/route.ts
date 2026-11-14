import { NextResponse } from 'next/server';
import { requireMobileFeature } from '@/lib/mobile/session';
import { analysisRequest } from '@/lib/inventory/analysis/reader';
import { createAuthorizedAnalysisReader, signAnalysisItems } from '@/lib/inventory/analysis/server';

export const dynamic = 'force-dynamic';
const MAX_BODY = 12 * 1024;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

async function readBoundedBody(request: Request): Promise<unknown> {
  const size = request.headers.get('content-length');
  if ((size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BODY)) || !request.body) throw new Error('INVALID_BODY');
  const reader = request.body.getReader();
  const buffers: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw new Error('INVALID_BODY');
      }
      buffers.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers)));
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const session = await requireMobileFeature('sales');
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status, headers });
  try {
    const body = await readBoundedBody(request);
    if (!body || typeof body !== 'object' || !('operation' in body) || !('request' in body) ||
        Object.keys(body).length !== 2) throw new Error('INVALID_BODY');
    const reader = createAuthorizedAnalysisReader(session.owner);
    if (body.operation === 'summary' && analysisRequest(body.request, false)) {
      return NextResponse.json({ owner: session.owner, result: await reader.summary(body.request) }, { headers });
    }
    if (body.operation === 'detail' && analysisRequest(body.request, true)) {
      const result = await reader.detail(body.request);
      return NextResponse.json({ owner: session.owner, result: result.status === 'ok' ? { ...result, items: await signAnalysisItems(result.items) } : result }, { headers });
    }
  } catch {
    return NextResponse.json({ error: 'INVALID_ANALYSIS_REQUEST' }, { status: 422, headers });
  }
  return NextResponse.json({ error: 'INVALID_ANALYSIS_REQUEST' }, { status: 422, headers });
}

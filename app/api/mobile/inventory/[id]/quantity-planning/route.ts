import { NextResponse } from 'next/server';
import { fields } from '@/lib/inventory/analysis/normalize';
import type { QuantityPlanningCalculationResult, QuantityPlanningReadResult } from '@/lib/inventory/quantityPlanning/contracts';
import { quantityPlanningServer } from '@/lib/inventory/quantityPlanning/server';
import { hasKeys } from '@/lib/inventory/quantityPlanning/settings';
import { getMobileSession } from '@/lib/mobile/session';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const MAX_BODY = 4096;
const httpStatus = { ok: 200, forbidden: 403, 'not-found': 404, invalid: 422, conflict: 409, error: 503 } as const;
const writesEnabled = () => process.env.BELLO_MOBILE_WRITES_ENABLED === 'true';
function response(owner: string, result: QuantityPlanningReadResult | QuantityPlanningCalculationResult) {
  if (result.status === 'ok' && !writesEnabled()) {
    result = 'token' in result ? { ...result, token: null } : { ...result, canEdit: false };
  }
  return NextResponse.json({ owner, result }, { status: httpStatus[result.status], headers });
}
const invalid = { status: 'invalid', message: '入力内容を確認してください。' } as const;
const forbidden = { status: 'forbidden', message: '操作権限を確認してください。' } as const;
type Context = { params: Promise<{ id: string }> };

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (!request.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export async function GET(_request: Request, context: Context) {
  const session = await getMobileSession();
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status, headers });
  const { id } = await context.params;
  return response(session.owner, await quantityPlanningServer(session.owner).read(id));
}

export async function POST(request: Request, context: Context) {
  const session = await getMobileSession();
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status, headers });
  const origin = request.headers.get('origin');
  const publicOrigin = process.env.BELLO_MOBILE_PUBLIC_ORIGIN || new URL(request.url).origin;
  if (request.headers.get('x-bello-mobile') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site' ||
      (origin && origin !== publicOrigin)) return response(session.owner, forbidden);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response(session.owner, invalid);
  const body = fields(await readBody(request));
  if (!body) return response(session.owner, invalid);
  const { id } = await context.params;
  const service = quantityPlanningServer(session.owner);
  if (body.action === 'calculate' && hasKeys(body, ['action', 'conditions'])) {
    return response(session.owner, await service.calculate(id, body.conditions));
  }
  if (body.action === 'save' && hasKeys(body, ['action', 'conditions', 'token', 'operationId'])) {
    const save = { ...body };
    delete save.action;
    return response(session.owner, await service.save(id, save, writesEnabled()));
  }
  return response(session.owner, invalid);
}

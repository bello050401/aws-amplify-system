import { isOutboundRequestOriginAllowed } from '@/lib/outbound/requestOrigin';
import { CatalogError } from './grants';
/** Native requests reuse the existing signed Cognito-cookie bridge. Browsers
 * must supply this app's Origin; native no-Origin requests require a custom
 * header and no browser fetch metadata. No CORS permission is granted here. */
export function requireCatalogMutationOrigin(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  const native = !request.headers.has('origin') && !request.headers.has('sec-fetch-site') && request.headers.get('x-bello-mobile') === '1';
  if (site === 'cross-site' || (!native && !isOutboundRequestOriginAllowed(request))) throw new CatalogError(403, '送信元を確認できません。');
}
export async function catalogJsonBody(request: Request, maxBytes = 65536): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) throw new CatalogError(400, '入力内容を確認してください。');
  const reader = request.body?.getReader();
  if (!reader) throw new CatalogError(400, '入力内容を確認してください。');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new CatalogError(400, '入力内容が長すぎます。'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CatalogError(400, '入力内容を確認してください。'); }
}

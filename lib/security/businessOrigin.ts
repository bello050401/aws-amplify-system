import { SecurityError } from './types';

/** Amplify reconstructs NextRequest.url with its internal SSR hostname.
 * Only the configured public origin may be used as the cryptographic audience
 * or a redirect destination. Never derive it from Host/Forwarded headers.
 * The device proof remains mandatory, including when navigation omits Origin.
 */
export function checkBusinessOrigin(headers: Headers, publicOrigin: string) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin ||
      (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)))
    throw new SecurityError('SECURITY_NOT_CONFIGURED', 503);
  if (headers.get('sec-fetch-site') === 'cross-site' ||
      (headers.has('origin') && headers.get('origin') !== publicOrigin))
    throw new SecurityError('INVALID_ORIGIN');
}

export function securityReturnUrl(publicOrigin: string, path: string, search: string) {
  checkBusinessOrigin(new Headers(), publicOrigin);
  const url = new URL('/security', publicOrigin);
  url.searchParams.set('returnTo', path + search);
  return url;
}

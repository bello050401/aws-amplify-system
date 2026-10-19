/** Amplify can use an internal request URL behind the public staff-app origin. */
export function isOutboundRequestOriginAllowed(
  request: Request,
  publicOrigin = process.env.BELLO_MOBILE_PUBLIC_ORIGIN,
): boolean {
  try {
    const configured = publicOrigin?.trim();
    const expected = new URL(configured || request.url);
    if (!['http:', 'https:'].includes(expected.protocol)) return false;
    if (configured && (expected.origin !== configured || expected.username || expected.password)) return false;
    // Do not trust a forwarded-host header or fall back when configuration is invalid.
    return request.headers.get('origin') === expected.origin;
  } catch {
    return false;
  }
}

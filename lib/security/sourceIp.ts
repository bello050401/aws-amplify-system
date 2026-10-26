/** Correlation only, never evidence of identity or IP without a matching AWS log. */
export function edgeRequestId(headers:Headers):string {
  const value=headers.get('x-amz-cf-id')??'';
  return /^[A-Za-z0-9_+\/-]{16,200}={0,2}$/.test(value)?value:'';
}
/** Amplify request headers alone are not verified connection evidence. ADMIN
 * views resolve the AWS request ID against the separately protected WAF log. */
export function trustedSourceIp(_headers:Headers):string {
  void _headers; // Preserve the boundary signature without trusting any header.
  return 'hosting-unverified';
}

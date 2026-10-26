/** Business documents only; the public storefront keeps its existing policy. */
export function businessContentPolicy(nonce:string,development=false){
  return ["default-src 'self'",`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development?" 'unsafe-eval'":''}`,
    "style-src 'self' 'unsafe-inline'","img-src 'self' https: data: blob:","font-src 'self' data:",
    "connect-src 'self' https://*.s3.us-west-2.amazonaws.com https://s3.us-west-2.amazonaws.com"+(development?' ws://localhost:*':''),
    "worker-src 'self' blob:","media-src 'self' blob:","frame-src 'self' blob:","object-src 'none'","base-uri 'none'","form-action 'self'","frame-ancestors 'none'"] .join('; ');
}

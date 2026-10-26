import {isIP} from 'node:net';
/** Correlation only, never evidence of identity or IP without a matching AWS log. */
export function edgeRequestId(headers:Headers):string {
  const value=headers.get('x-amz-cf-id')??'';
  return /^[A-Za-z0-9_+\/-]{16,200}={0,2}$/.test(value)?value:'';
}
/** Enable only after hosting overwrites this header and its origin is inaccessible
 * directly. X-Forwarded-For supplied by a caller is never an authentication signal. */
export function trustedSourceIp(headers:Headers,source=process.env.SECURITY_TRUSTED_SOURCE):string {
  if(source!=='cloudfront-viewer-address')return 'hosting-unverified';
  const value=headers.get('cloudfront-viewer-address')??'';
  const candidate=value.startsWith('[')?value.slice(1,value.indexOf(']')):value.slice(0,value.lastIndexOf(':'));
  return isIP(candidate)?candidate:'hosting-unverified';
}

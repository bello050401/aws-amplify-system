import {isIP} from 'node:net';
/** Enable only after hosting overwrites this header and its origin is inaccessible
 * directly. X-Forwarded-For supplied by a caller is never an authentication signal. */
export function trustedSourceIp(headers:Headers,source=process.env.SECURITY_TRUSTED_SOURCE):string {
  if(source!=='cloudfront-viewer-address')return 'hosting-unverified';
  const value=headers.get('cloudfront-viewer-address')??'';
  const candidate=value.startsWith('[')?value.slice(1,value.indexOf(']')):value.slice(0,value.lastIndexOf(':'));
  return isIP(candidate)?candidate:'hosting-unverified';
}

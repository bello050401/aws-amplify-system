import {randomBytes} from 'node:crypto';
import {NextResponse,type NextRequest} from 'next/server';

const callbacks=new Set(['/api/base/oauth/callback','/api/invoicing/oauth/callback','/api/sale-candidates/oauth']);
/** A cross-site OAuth return has no Strict session cookie. Commit an inert
 * same-origin document first, then repeat the navigation with the normal
 * signed device boundary. This never exchanges a code or grants access. */
export function oauthReturnLanding(request:NextRequest){
 if(request.method!=='GET'||!callbacks.has(request.nextUrl.pathname)||
    request.headers.get('sec-fetch-dest')!=='document'||request.headers.get('sec-fetch-site')!=='cross-site')return null;
 const nonce=randomBytes(18).toString('base64');
 return new NextResponse('<!doctype html><html lang="ja"><meta charset="utf-8"><title>BELLO 接続確認</title><p>接続結果を確認しています…</p><script nonce="'+nonce+'">location.replace(location.href)</script></html>',{headers:{
  'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options':'nosniff',
 }});
}

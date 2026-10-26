/** Authentication-boundary tests; never contact an external OAuth provider. */
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {configuredSecurityOrigin,resolveAppOrigin} from '../lib/http/appOrigin';
import {buildRedirectUriFromHost,resolveRedirectUri} from '../lib/base/redirectUri';
import {oauthReturnLanding} from '../lib/security/oauthReturn';
const names=['BELLO_DEVICE_SECURITY','SECURITY_ORIGIN','BASE_REDIRECT_URI'] as const;
const before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
const origin='https://bello.example.test',callback=origin+'/api/base/oauth/callback';
let passed=0;
async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log('PASS '+name);}
async function main(){try{
 process.env.BELLO_DEVICE_SECURITY='enforced';process.env.SECURITY_ORIGIN=origin;delete process.env.BASE_REDIRECT_URI;
 await test('Enforced origin ignores Host and forwarded-host/proto',()=>assert.equal(resolveAppOrigin(new Request('http://internal.local/callback',{headers:{host:'evil.invalid','x-forwarded-host':'evil.invalid','x-forwarded-proto':'http'}})),origin));
 await test('BASE authorize, exchange and settings display use the identical configured callback',()=>{assert.equal(resolveRedirectUri(new Request('http://internal.local/')),callback);assert.equal(buildRedirectUriFromHost('evil.invalid'),callback);assert.equal(buildRedirectUriFromHost(null),callback);});
 await test('BASE rejects a configured callback outside the authenticated origin',()=>{process.env.BASE_REDIRECT_URI='https://other.invalid/cb';assert.throws(()=>resolveRedirectUri(new Request(origin)),/MISMATCH/);assert.throws(()=>buildRedirectUriFromHost(null),/MISMATCH/);process.env.BASE_REDIRECT_URI=callback;assert.equal(buildRedirectUriFromHost(null),callback);delete process.env.BASE_REDIRECT_URI;});
 await test('Missing or malformed enforced configuration cannot fall back to request headers',()=>{for(const value of ['',origin+'/',origin+'/path','http://remote.invalid','https://user:pass@bello.example.test']){process.env.SECURITY_ORIGIN=value;assert.throws(()=>configuredSecurityOrigin());}process.env.SECURITY_ORIGIN=origin;});
 await test('Legacy deployments retain their explicitly configured callback behavior',()=>{delete process.env.BELLO_DEVICE_SECURITY;process.env.BASE_REDIRECT_URI='https://legacy.example.test/cb';assert.equal(resolveRedirectUri(new Request(origin)),process.env.BASE_REDIRECT_URI);delete process.env.BASE_REDIRECT_URI;assert.equal(resolveAppOrigin(new Request('http://internal.local/',{headers:{'x-forwarded-host':'legacy.example.test'}})),'https://legacy.example.test');process.env.BELLO_DEVICE_SECURITY='enforced';});
 for(const path of ['/api/base/oauth/callback','/api/invoicing/oauth/callback','/api/sale-candidates/oauth']){
  await test('Inert cross-site return: '+path,async()=>{
   const request=new NextRequest(origin+path+'?code=SECRET_CODE&state=SECRET_STATE',{headers:{'sec-fetch-dest':'document','sec-fetch-site':'cross-site'}});
   const response=oauthReturnLanding(request)!;assert.equal(response.status,200);
   const html=await response.text();assert(html.includes('location.replace(location.href)'));assert(!html.includes('SECRET_'));assert(!response.headers.has('set-cookie'));
   assert(response.headers.get('cache-control')?.includes('no-store'));assert.equal(response.headers.get('referrer-policy'),'no-referrer');
   const nonce=html.match(/nonce="([^"]+)"/)?.[1];assert(nonce);assert(response.headers.get('content-security-policy')?.includes("'nonce-"+nonce+"'"));assert(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
   const next=oauthReturnLanding(request)!;assert.notEqual(next.headers.get('content-security-policy'),response.headers.get('content-security-policy'));
  });
 }
 await test('Same-site return continues to mandatory session and device validation',()=>{for(const site of ['same-origin','same-site','none'])assert.equal(oauthReturnLanding(new NextRequest(callback,{headers:{'sec-fetch-dest':'document','sec-fetch-site':site}})),null);});
 await test('Landing exception cannot cover POST, fetch, iframe or unrelated business routes',()=>{for(const [method,path,dest] of [['POST','/api/base/oauth/callback','document'],['GET','/api/base/oauth/callback','empty'],['GET','/api/base/oauth/callback','iframe'],['GET','/api/mobile/inventory','document']])assert.equal(oauthReturnLanding(new NextRequest(origin+path,{method,headers:{'sec-fetch-dest':dest,'sec-fetch-site':'cross-site'}})),null);});
 console.log(JSON.stringify({passed,failed:0,externalProvidersContacted:false}));
 }finally{for(const n of names){if(before[n]===undefined)delete process.env[n];else process.env[n]=before[n];}}}
main().catch(e=>{console.error(e);process.exitCode=1;});

import assert from 'node:assert/strict';
import {checkBusinessOrigin,securityReturnUrl} from '../lib/security/businessOrigin';
const origin='https://stage.example.com';
let passed=0;
function test(name:string,fn:()=>void){fn();passed++;console.log('PASS '+name)}
test('Same-origin request remains valid behind an internal SSR host',()=>checkBusinessOrigin(new Headers({origin,host:'internal-amplify:3000'}),origin));
test('Document navigation without Origin still requires downstream proof',()=>checkBusinessOrigin(new Headers({'sec-fetch-site':'same-origin'}),origin));
test('Cross-origin Origin is rejected',()=>assert.throws(()=>checkBusinessOrigin(new Headers({origin:'https://evil.example.com'}),origin),/INVALID_ORIGIN/));
test('Opaque null Origin is rejected',()=>assert.throws(()=>checkBusinessOrigin(new Headers({origin:'null'}),origin),/INVALID_ORIGIN/));
test('Cross-site metadata is rejected even with forged Origin',()=>assert.throws(()=>checkBusinessOrigin(new Headers({origin,'sec-fetch-site':'cross-site'}),origin),/INVALID_ORIGIN/));
test('Forwarded host cannot override configured audience',()=>assert.throws(()=>checkBusinessOrigin(new Headers({origin:'https://evil.example.com','x-forwarded-host':'stage.example.com'}),origin),/INVALID_ORIGIN/));
test('Login redirects use configured public HTTPS origin',()=>{const u=securityReturnUrl(origin,'/inventory','?page=2');assert.equal(u.origin,origin);assert.equal(u.pathname,'/security');assert.equal(u.searchParams.get('returnTo'),'/inventory?page=2')});
test('Insecure nonlocal origin is fail-closed',()=>assert.throws(()=>checkBusinessOrigin(new Headers(),'http://stage.example.com'),/SECURITY_NOT_CONFIGURED/));
test('Origin with a path cannot alter login destination',()=>assert.throws(()=>securityReturnUrl(origin+'/evil','/inventory',''),/SECURITY_NOT_CONFIGURED/));
console.log(JSON.stringify({passed}));

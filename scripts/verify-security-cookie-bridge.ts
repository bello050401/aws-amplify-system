import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {serverCookieBridge} from '../lib/security/serverCookieBridge';
const jwt=(payload:unknown)=>[Buffer.from('{"alg":"RS256"}').toString('base64url'),Buffer.from(JSON.stringify(payload)).toString('base64url'),'signature'].join('.');
const exp=Math.floor(Date.now()/1000)+300,client='testclient';
const require=createRequire(import.meta.url);
const {createCookieStorageAdapterFromNextServerContext:adapter}=require(join(dirname(require.resolve('@aws-amplify/adapter-nextjs')),'utils/createCookieStorageAdapterFromNextServerContext.js'));
async function main(){
 for(const username of ['staff@example.invalid','staff+photo@example.invalid','plain-staff']){
  const tokens={access:jwt({sub:'subject',username,exp,iat:exp-300,token_use:'access','cognito:groups':['EDITOR']}),id:jwt({sub:'subject',email:username,exp,iat:exp-300,token_use:'id'}),refresh:'must-not-enter-cookie-adapter',expiresAt:exp};
  const jar=serverCookieBridge(client,{username,tokens});
  const sdk=await adapter({cookies:async()=>jar});
  const prefix='CognitoIdentityServiceProvider.'+client+'.';
  assert.equal(sdk.get(prefix+'LastAuthUser')?.value,username);
  assert.equal(sdk.get(prefix+username+'.accessToken')?.value,tokens.access);
  assert.equal(sdk.get(prefix+username+'.idToken')?.value,tokens.id);
  assert(!JSON.stringify(jar.getAll()).includes(tokens.refresh));
  assert.throws(()=>jar.set(),/SERVER_ONLY_SESSION/);
 }
 const empty=await adapter({cookies:async()=>serverCookieBridge(client,null)});
 assert(!empty.get('CognitoIdentityServiceProvider.'+client+'.LastAuthUser'));
 console.log('PASS actual Amplify adapter: email, plus-address, username, no-session; no refresh token or browser writes');
}
main().catch(error=>{console.error(error.message);process.exitCode=1});

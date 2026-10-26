import assert from 'node:assert/strict';
import {securityHttp,COOKIE} from '../lib/security/http';
import {SecurityService} from '../lib/security/service';
import {SecurityError} from '../lib/security/types';
import {isTerminalSessionError} from '../lib/security/sessionInvalidation';
const origin='https://security.example.test';
const request={method:'POST',path:'/api/security/challenge',headers:{origin,'content-type':'application/json',cookie:COOKIE+'='+'a'.repeat(43)},body:'{}',ip:'192.0.2.1'};
async function main(){
 let passed=0;
 for(const code of ['DEVICE_REVOKED','SESSION_EXPIRED','ACCOUNT_DISABLED']){
  const service={origin,challenge:async()=>{throw new SecurityError(code,403)},audit:async()=>{}} as unknown as SecurityService;
  const result=await securityHttp(service,request);assert.equal(result.statusCode,403);assert(result.cookies?.[0].includes('Max-Age=0'));passed++;
 }
 for(const code of ['DEVICE_PENDING','DEVICE_REJECTED','STALE_RECORD','SECURITY_UNAVAILABLE']){
  const service={origin,challenge:async()=>{throw new SecurityError(code,403)},audit:async()=>{}} as unknown as SecurityService;
  assert.equal((await securityHttp(service,request)).cookies,undefined);passed++;
 }
 const service={origin,audit:async()=>{}} as unknown as SecurityService;
 assert.equal((await securityHttp(service,{...request,headers:{...request.headers,origin:'https://untrusted.example'}})).cookies,undefined);passed++;
 for(const code of ['forbidden','INSUFFICIENT_PERMISSION','UNAVAILABLE',undefined])assert.equal(isTerminalSessionError(code),false);passed++;
 console.log(JSON.stringify({passed,failed:0,scope:'terminal session cleanup; pending preserved; business/network denial does not sign out'}));
}
main().catch(e=>{console.error(e);process.exitCode=1});

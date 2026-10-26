import assert from 'node:assert/strict';
import {createEdgeAuditEnricher,matchEdgeIp,type EdgeRecord} from '../lib/security/edgeAudit';
import {edgeRequestId,trustedSourceIp} from '../lib/security/sourceIp';
import type {Row} from '../lib/security/types';
const at=1800000000,host='stage.example.com',id='CF_AWS_GENERATED_REQUEST_0123456789';
const row:Row={id:'device#test',version:7,kind:'device',lastIp:'hosting-unverified',edgeRequestId:id,edgeAt:at,edgeTarget:'/api/security/action',edgeMethod:'POST'};
const record:EdgeRecord={timestamp:at*1000,httpSourceName:'CF',httpRequest:{requestId:id,clientIp:'192.0.2.44',uri:row.edgeTarget as string,httpMethod:'POST',headers:[{name:'Host',value:host},{name:'x-forwarded-for',value:'198.51.100.99'}]}};
let passed=0;async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log('PASS '+name)}
async function main(){
await test('Only matching AWS connection IP is used, not forwarded IP',()=>assert.equal(matchEdgeIp(row,[record],host),'192.0.2.44'));
await test('Wrong host, path, method, ID or timestamp remain unverified',()=>{for(const r of [{...record,timestamp:(at-91)*1000},{...record,httpSourceName:'ALB'},...([{headers:[{name:'host',value:'other.example.com'}]},{uri:'/another'},{httpMethod:'GET'},{requestId:'different_id'},{clientIp:'invalid'}].map(p=>({...record,httpRequest:{...record.httpRequest,...p}})))])assert.equal(matchEdgeIp(row,[r],host),undefined)});
await test('Ambiguous matching connection addresses fail closed',()=>assert.equal(matchEdgeIp(row,[record,{...record,httpRequest:{...record.httpRequest,clientIp:'192.0.2.45'}}],host),undefined));
await test('Duplicate AWS log delivery is harmless',()=>assert.equal(matchEdgeIp(row,[record,record],host),'192.0.2.44'));
await test('Canonical HTTPS host variants accepted but duplicate Host rejected',()=>{for(const value of [host.toUpperCase(),host+':443',host+'.',host+'.:443'])assert.equal(matchEdgeIp(row,[{...record,httpRequest:{...record.httpRequest,headers:[{name:'host',value}]}}],host),'192.0.2.44');assert.equal(matchEdgeIp(row,[{...record,httpRequest:{...record.httpRequest,headers:[{name:'host',value:host},{name:'Host',value:host}]}}],host),undefined)});
await test('IPv6 connection addresses supported',()=>assert.equal(matchEdgeIp(row,[{...record,httpRequest:{...record.httpRequest,clientIp:'2001:db8::1'}}],host),'2001:db8::1'));
await test('Missing AWS evidence cannot become a verified address',async()=>{const e=createEdgeAuditEnricher(host,async()=>[],()=>at*1000);assert.deepEqual(await e([row]),[row])});
await test('Log outage does not block authentication or change device record',async()=>{const e=createEdgeAuditEnricher(host,async()=>{throw Error('unavailable')},()=>at*1000);assert.deepEqual(await e([row]),[row])});
await test('Verified display preserves record identity and CAS version',async()=>{const e=createEdgeAuditEnricher(host,async()=>[record],()=>at*1000);const [r]=await e([row]);assert.equal(r.version,7);assert.equal(r.id,row.id);assert.equal(r.lastIp,'192.0.2.44');assert.equal(r.edgeIpVerified,true);assert.equal(row.lastIp,'hosting-unverified')});
await test('Audit export gets IP but never raw headers or response body',async()=>{const e=createEdgeAuditEnricher(host,async()=>[record],()=>at*1000);const [r]=await e([{...row,id:'event#test',kind:'event',ip:'hosting-unverified'}]);assert.equal(r.ip,'192.0.2.44');assert(!JSON.stringify(r).includes('198.51.100.99'));assert(!('headers' in r))});
await test('Verified cache is short and avoids repeat requests',async()=>{let calls=0,time=at*1000;const e=createEdgeAuditEnricher(host,async()=>{calls++;return[record]},()=>time);await e([row]);await e([row]);assert.equal(calls,1);time+=61000;await e([row]);assert.equal(calls,2)});
await test('Expired metadata and malicious filter IDs do not trigger log queries',async()=>{let calls=0;const e=createEdgeAuditEnricher(host,async()=>{calls++;return[]},()=>at*1000);await e([{...row,edgeRequestId:'" || attack'},{...row,edgeAt:at-91*86400}]);assert.equal(calls,0)});
await test('Header parsing rejects malformed and unbounded identifiers',()=>{assert.equal(edgeRequestId(new Headers({'x-amz-cf-id':id})),id);for(const value of ['', 'short', 'a'.repeat(203),'" || attack'])assert.equal(edgeRequestId(new Headers({'x-amz-cf-id':value})), '')});
await test('No environment flag may trust a caller-supplied viewer address',()=>{const old=process.env.SECURITY_TRUSTED_SOURCE;try{process.env.SECURITY_TRUSTED_SOURCE='cloudfront-viewer-address';assert.equal(trustedSourceIp(new Headers({'cloudfront-viewer-address':'198.51.100.77:443','x-forwarded-for':'198.51.100.77'})),'hosting-unverified')}finally{if(old===undefined)delete process.env.SECURITY_TRUSTED_SOURCE;else process.env.SECURITY_TRUSTED_SOURCE=old}});
console.log(JSON.stringify({passed,failed:0,live:false}));
}main().catch(e=>{console.error(e.message);process.exitCode=1});

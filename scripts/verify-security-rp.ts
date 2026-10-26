import assert from 'node:assert/strict';
import {configure} from '../amplify/security/passkeyConfigurationHandler';
const event={RequestType:'Create',ResourceProperties:{PoolId:'us-west-2_fixture',Hostname:'cognito-production-length-compatibility-20261026.bello.example.com'}};
let passed=0;async function test(name:string,fn:()=>Promise<unknown>){await fn();passed++;console.log('PASS '+name)}
async function main(){
 for(const mode of ['OFF','OPTIONAL','ON'])await test('Preserve '+mode+' and every configured MFA factor',async()=>{
  const before={MfaConfiguration:mode,SoftwareTokenMfaConfiguration:{Enabled:true},SmsMfaConfiguration:{SmsAuthenticationMessage:'Code {####}',SmsConfiguration:{SnsCallerArn:'arn:aws:iam::111122223333:role/test'}},EmailMfaConfiguration:{Subject:'Code',Message:'{####}'}};
  const calls:any[]=[];await configure(event,{send:async command=>{calls.push(command.input);return calls.length===1?before:{}}});
  assert.deepEqual(calls[1],{UserPoolId:event.ResourceProperties.PoolId,...before,WebAuthnConfiguration:{RelyingPartyId:event.ResourceProperties.Hostname,UserVerification:'required',FactorConfiguration:'MULTI_FACTOR_WITH_USER_VERIFICATION'}});
 });
 await test('Unknown or unreadable current MFA never writes',async()=>{let writes=0;await assert.rejects(configure(event,{send:async c=>{if(c.constructor.name.startsWith('Set'))writes++;return {}}}));assert.equal(writes,0)});
 await test('Configuration failure is propagated to deployment rollback',async()=>{await assert.rejects(configure(event,{send:async c=>{if(c.constructor.name.startsWith('Get'))return{MfaConfiguration:'OFF'};throw Error('write failed')}}),/write failed/)});
 await test('Deleting deployment helper does not delete or weaken pool',async()=>{let calls=0;await configure({...event,RequestType:'Delete'},{send:async()=>{calls++;return{}}});assert.equal(calls,0)});
 await test('Invalid domain or different region does not call AWS',async()=>{let calls=0;for(const props of [{...event.ResourceProperties,Hostname:'attacker.invalid/path'},{...event.ResourceProperties,PoolId:'us-east-1_bad'}])await assert.rejects(configure({...event,ResourceProperties:props},{send:async()=>{calls++;return{}}}));assert.equal(calls,0)});
 console.log(JSON.stringify({passed,failed:0}));
}main().catch(e=>{console.error(e.message);process.exitCode=1});

import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {approveRecoveryDevice,assertRecoveryCaller} from '../lib/security/operatorRecovery';
import {keyId} from '../lib/security/crypto';
import {SecurityError,type Store,type Row,type Device,type User} from '../lib/security/types';
const rows=new Map<string,Row>(),store:Store={get:async(id)=>structuredClone(rows.get(id)) as any,list:async()=>({items:[]}),rate:async()=>{},write:async(ms)=>{
 for(const m of ms){if(!('row'in m))throw Error();const old=rows.get(m.row.id);if(m.expected===null?!!old:old?.version!==m.expected)throw new SecurityError('STALE_RECORD',409)}
 for(const m of ms)if('row'in m)rows.set(m.row.id,structuredClone(m.row));
}};
const publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
const user:User={id:'user#admin',kind:'user',version:1,sub:'admin',username:'QA',groups:['ADMIN'],enabled:true,generation:1,passkeyRegistered:true};
const device:Device={id:'device#admin#new',kind:'device',version:1,sub:'admin',name:'QA',status:'pending',publicKey,shared:false,generation:1,requestedAt:1,lastSeenAt:1,lastIp:'192.0.2.1',userAgent:'QA',verificationCode:'123456'};
const input={sub:user.sub,deviceId:device.id,version:1,fingerprint:keyId(publicKey),verificationCode:'123456',personConfirmed:true},arn='arn:aws:sts::123456789012:assumed-role/RecoveryMfa/operator';
let passed=0;async function test(name:string,fn:()=>Promise<void>){rows.set(user.id,structuredClone(user));rows.set(device.id,structuredClone(device));await fn();passed++;console.log('PASS '+name)}
async function denied(fn:()=>Promise<unknown>,code:string){await assert.rejects(fn,(e:unknown)=>e instanceof SecurityError&&e.code===code)}
async function main(){
 await test('A normal SSO administrator role is not the dedicated recovery role',async()=>{
  assert.throws(()=>assertRecoveryCaller('arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator','arn:aws:iam::123456789012:role/RecoveryMfa','123456789012'));
  assert.throws(()=>assertRecoveryCaller(arn,'arn:aws:iam::999999999999:role/RecoveryMfa','123456789012'));
 });
 await test('Only the configured same-account recovery role is accepted',async()=>assertRecoveryCaller(arn,'arn:aws:iam::123456789012:role/RecoveryMfa','123456789012'));
 await test('Long-lived IAM user cannot perform recovery',()=>denied(()=>approveRecoveryDevice(store,input,'arn:aws:iam::123456789012:user/operator'),'RECOVERY_ASSUMED_ROLE_REQUIRED'));
 await test('Password-only account cannot gain emergency approval',async()=>{rows.set(user.id,{...user,passkeyRegistered:false});await denied(()=>approveRecoveryDevice(store,input,arn),'RECOVERY_ADMIN_PASSKEY_REQUIRED')});
 await test('Disabled administrator cannot be revived by approval',async()=>{rows.set(user.id,{...user,enabled:false});await denied(()=>approveRecoveryDevice(store,input,arn),'RECOVERY_ADMIN_PASSKEY_REQUIRED')});
 await test('Revoked device cannot be restored',async()=>{rows.set(device.id,{...device,status:'revoked'});await denied(()=>approveRecoveryDevice(store,input,arn),'RECOVERY_PENDING_DEVICE_REQUIRED')});
 await test('Wrong fingerprint or missing human check denied',async()=>{await denied(()=>approveRecoveryDevice(store,{...input,fingerprint:'wrong'},arn),'PERSON_VERIFICATION_REQUIRED');await denied(()=>approveRecoveryDevice(store,{...input,personConfirmed:false},arn),'PERSON_VERIFICATION_REQUIRED')});
 await test('Verified recovery records approval and audit atomically',async()=>{await approveRecoveryDevice(store,input,arn);assert.equal(rows.get(device.id)?.status,'approved');assert([...rows.values()].some(r=>r.event==='OPERATOR_ADMIN_RECOVERY'))});
 await test('Replaying the recovery does not approve twice',async()=>{await approveRecoveryDevice(store,input,arn);await denied(()=>approveRecoveryDevice(store,input,arn),'RECOVERY_PENDING_DEVICE_REQUIRED')});
 console.log(JSON.stringify({passed,failed:0,operatorMfaLive:'NOT_TESTED'}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});

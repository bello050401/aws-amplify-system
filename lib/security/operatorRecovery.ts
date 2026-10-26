import {keyId,randomId,safeText} from './crypto';
import {SecurityError,type Store,type User,type Device} from './types';

/** Emergency operator path, intentionally not exported by any HTTP route.
 * An AWS operator must verify the employee, exact pending key and request code.
 * Existing/revoked keys and password-only accounts cannot be promoted here. */
export async function approveRecoveryDevice(store:Store,input:{sub:string;deviceId:string;version:number;fingerprint:string;verificationCode:string;personConfirmed:boolean},operatorArn:string,now=Math.floor(Date.now()/1000)){
 if(!/^arn:aws:sts::\d{12}:assumed-role\//.test(operatorArn))throw new SecurityError('RECOVERY_ASSUMED_ROLE_REQUIRED');
 const [user,device]=await Promise.all([store.get<User>('user#'+input.sub),store.get<Device>(input.deviceId)]);
 if(!user?.enabled||!user.groups.includes('ADMIN')||!user.passkeyRegistered)throw new SecurityError('RECOVERY_ADMIN_PASSKEY_REQUIRED');
 if(!device||device.sub!==user.sub||device.status!=='pending'||device.version!==input.version)throw new SecurityError('RECOVERY_PENDING_DEVICE_REQUIRED');
 if(!input.personConfirmed||input.fingerprint!==keyId(device.publicKey)||input.verificationCode!==device.verificationCode)throw new SecurityError('PERSON_VERIFICATION_REQUIRED');
 await store.write([
  {expected:device.version,row:{...device,version:device.version+1,status:'approved',decidedAt:now,decidedBy:operatorArn}},
  {expected:null,row:{id:'event#'+String(now).padStart(12,'0')+'#'+randomId(),kind:'event',version:1,at:now,event:'OPERATOR_ADMIN_RECOVERY',result:'approved',sub:user.sub,deviceId:device.id,operator:safeText(operatorArn,240),expiresAt:now+90*86400}},
 ]);
 return {deviceId:device.id,status:'approved'};
}

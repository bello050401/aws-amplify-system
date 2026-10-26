import { randomInt } from "node:crypto";
import { hash, keyId, publicKey, safeText, verifyProof } from "./crypto";
import { requestProofMessage, type RequestProof } from "./requestProof";
import { SecurityError, type Store, type Device, type User, type Context } from "./types";

/** Additional device-key boundary AFTER API Gateway verifies the PhotoStation JWT. */
export async function authorizePhotoDevice(store:Store, request:{sub:string;groups:string[];authTime?:number;legacyDeviceId:string|null;key:unknown;proof:RequestProof;method:string;target:string;body:string;register:boolean;name?:string},ctx:Context,now=Math.floor(Date.now()/1000)) {
  if(!request.sub||!request.groups.includes("PHOTO_DEVICE"))throw new SecurityError("PHOTO_DEVICE_REQUIRED");
  const key=publicKey(request.key),p=request.proof,id="device#photo#"+request.sub+"#"+keyId(key);
  if(!p||p.version!==1||!Number.isSafeInteger(p.at)||Math.abs(now-p.at)>30||! /^[A-Za-z0-9_-]{43}$/.test(p.nonce)||
    p.binding!==hash("photo#"+request.sub)||p.digest!==hash(request.body)||
    !verifyProof(key,requestProofMessage(ctx.origin,request.method,request.target,p),p.signature))throw new SecurityError("INVALID_DEVICE_PROOF");
  await store.write([{expected:null,row:{id:"photo-proof#"+hash(id+p.nonce),kind:"http-proof",version:1,expiresAt:now+120}}]);
  const [device,user]=await Promise.all([store.get<Device>(id),store.get<User>("user#"+request.sub)]);
  if(user&&!user.enabled)throw new SecurityError("ACCOUNT_DISABLED");
  // A refresh keeps Cognito auth_time unchanged. Only a new actual login can
  // resume after the administrator forces a machine account to log out.
  if(user?.revokedBefore && (!Number.isSafeInteger(request.authTime) || request.authTime! <= Number(user.revokedBefore)))
    throw new SecurityError("SIGN_IN_REQUIRED",401);
  if(request.register&&!device){
    await store.rate("photo-register#"+request.sub,5,86400,now);
    const row:Device={id,kind:"device",version:1,sub:request.sub,name:safeText(request.name,80)||"PhotoStation",publicKey:key,
      status:"pending",shared:true,generation:1,requestedAt:now,lastSeenAt:now,lastIp:safeText(ctx.ip,64),userAgent:safeText(ctx.userAgent,240),
      verificationCode:String(randomInt(100000,1000000)),machine:true,legacyDeviceId:request.legacyDeviceId,username:"PhotoStation "+request.sub};
    await store.write([{expected:null,row},...(!user?[{expected:null,row:{id:"user#"+request.sub,kind:"user",version:1,sub:request.sub,username:"PhotoStation "+request.sub,groups:["PHOTO_DEVICE"],enabled:true,generation:1,passkeyRegistered:false}}]:[])]);
    return {pending:true,verificationCode:row.verificationCode,deviceId:request.legacyDeviceId||id};
  }
  if(!device)throw new SecurityError("DEVICE_REGISTRATION_REQUIRED");
  if(device.status!=="approved"){
    if(request.register&&device.status==="pending")return{pending:true,verificationCode:device.verificationCode,deviceId:request.legacyDeviceId||id};
    throw new SecurityError(device.status==="pending"?"DEVICE_PENDING":device.status==="rejected"?"DEVICE_REJECTED":"DEVICE_REVOKED");
  }
  if(device.legacyDeviceId!==request.legacyDeviceId)throw new SecurityError("DEVICE_ID_CHANGED");
  if(now-device.lastSeenAt>=60){
    try{await store.write([{expected:device.version,row:{...device,version:device.version+1,lastSeenAt:now,lastIp:safeText(ctx.ip,64),userAgent:safeText(ctx.userAgent,240)}}]);}
    catch(error){if(!(error instanceof SecurityError)||error.code!=='STALE_RECORD')throw error;
      const current=await store.get<Device>(id);if(current?.status!=='approved')throw new SecurityError('DEVICE_REVOKED');}
  }
  return{pending:false,deviceId:request.legacyDeviceId||id};
}

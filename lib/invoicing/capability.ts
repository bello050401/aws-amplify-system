import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
export type Capability={purpose:'issue'|'pdf'|'oauth';owner:string;operation:string;expires:number;billingId?:string;verifier?:string};
export function seal(value:Capability,key:string){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(key).digest(),iv);const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');}
export function unseal(ticket:unknown,key:string,owner:string,purpose:Capability['purpose'],now=Date.now()):Capability{
 if(typeof ticket!=='string'||ticket.length>2000)throw new Error('INVALID_CAPABILITY');
 try{const bytes=Buffer.from(ticket,'base64url');const cipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(key).digest(),bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));const v=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')) as Capability;
 if(v.purpose!==purpose||v.owner!==owner||!Number.isFinite(v.expires)||v.expires<=now||v.expires>now+1800000||!/^[-a-f0-9]{36}$/.test(v.operation))throw new Error();return v;
 }catch{throw new Error('INVALID_CAPABILITY');}
}

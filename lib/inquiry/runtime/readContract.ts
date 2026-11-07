import {createHash} from 'node:crypto';

export type ReadTarget={shopId:string;inquiryId:string};
export type ReadMessage={speaker:'BUYER'|'SELLER';body:string;sentAt:string};
export type ReadSnapshot=ReadTarget & {url:string;capturedAt:string;complete:true;productId:string|null;messages:ReadMessage[]};
const id=/^[A-Za-z0-9_-]{1,160}$/;
export function exactInquiryTarget(value:unknown):ReadTarget|null {
  if(typeof value!=='string')return null;
  try{const u=new URL(value);const m=u.pathname.match(/^\/seller\/shops\/([A-Za-z0-9_-]+)\/inquiries\/([A-Za-z0-9_-]+)\/?$/);
    return u.origin==='https://mercari-shops.com'&&!u.username&&!u.password&&m&&id.test(m[1])&&id.test(m[2])?{shopId:m[1],inquiryId:m[2]}:null;
  }catch{return null;}
}
export function inquiryReadUrl(target:ReadTarget){
  if(!id.test(target.shopId)||!id.test(target.inquiryId))throw Error('INVALID_READ_TARGET');
  return `https://mercari-shops.com/seller/shops/${target.shopId}/inquiries/${target.inquiryId}`;
}
export function validateReadSnapshot(raw:unknown,target:ReadTarget,now=Date.now()):ReadSnapshot{
  if(!raw||typeof raw!=='object')throw Error('INVALID_READ_RESULT');
  const s=raw as ReadSnapshot,t=exactInquiryTarget(s.url);
  if(!t||t.shopId!==target.shopId||t.inquiryId!==target.inquiryId||s.shopId!==target.shopId||s.inquiryId!==target.inquiryId||s.complete!==true)throw Error('READ_IDENTITY_MISMATCH');
  const at=Date.parse(s.capturedAt);
  if(!Number.isFinite(at)||at>now+30000||now-at>180000)throw Error('STALE_READ_RESULT');
  if(s.productId!==null&&!id.test(s.productId))throw Error('INVALID_PRODUCT_ID');
  if(!Array.isArray(s.messages)||!s.messages.length||s.messages.length>1000)throw Error('INCOMPLETE_READ_RESULT');
  let size=0,previous=-Infinity;
  const messages=s.messages.map(m=>{
    const when=Date.parse(m.sentAt);
    if(!['BUYER','SELLER'].includes(m.speaker)||typeof m.body!=='string'||!m.body.trim()||m.body.length>20000||!Number.isFinite(when)||when>at+60000||when<previous)throw Error('INVALID_READ_MESSAGE');
    size+=m.body.length;previous=when;
    return {speaker:m.speaker,body:m.body,sentAt:new Date(when).toISOString()};
  });
  if(size>70000)throw Error('READ_HISTORY_TOO_LARGE');
  return {...target,url:inquiryReadUrl(target),capturedAt:new Date(at).toISOString(),complete:true,productId:s.productId,messages};
}
export function readJobKey(pk:string,version:number,sourceMessageId:string){
  return 'READ#'+createHash('sha256').update(JSON.stringify([pk,version,sourceMessageId])).digest('hex');
}

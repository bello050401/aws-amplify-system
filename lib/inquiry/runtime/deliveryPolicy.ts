import {createHash} from 'node:crypto';
export type DeliveryMode='DRAFT'|'REVIEW'|'AUTO';
export type DeliveryState='QUEUED'|'SENDING'|'ACCEPTED'|'UNKNOWN'|'CANCELLED'|'REJECTED';
export type DeliveryPolicy={mode:DeliveryMode;approvedIntents:string[];evaluation?:{version:string;reviewer:string;cases:number;wrongProduct:number;wrongRecipient:number;duplicates:number;ungroundedPromises:number;factCorrectRate:number;identificationRate:number}};
export function evaluatedDeliveryAllowed(policy:DeliveryPolicy,intents:string[],manual:boolean){
  const e=policy.evaluation;
  if(!['REVIEW','AUTO'].includes(policy.mode)||(!manual&&policy.mode!=='AUTO')||!e?.reviewer?.trim()||!e.version||!Number.isInteger(e.cases)||e.cases<50||e.wrongProduct!==0||e.wrongRecipient!==0||e.duplicates!==0||e.ungroundedPromises!==0||!Number.isFinite(e.factCorrectRate)||e.factCorrectRate<.9||e.factCorrectRate>1||!Number.isFinite(e.identificationRate)||e.identificationRate<.9||e.identificationRate>1)return false;
  return Array.isArray(policy.approvedIntents)&&intents.length>0&&intents.every(intent=>policy.approvedIntents.includes(intent));
}
export function recentDraftProof(at:unknown,now=Date.now()){
  const time=typeof at==='string'?Date.parse(at):NaN;
  return Number.isFinite(time)&&time<=now+30000&&now-time<=300000;
}
export function deliveryFingerprint(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function deliveryJobId(conversationId:string,sourceId:string,draftId:string,draftVersion:string,destinationKey:string){return 'SEND#'+deliveryFingerprint([conversationId,sourceId,draftId,draftVersion,destinationKey]);}
export function transportOutcome(status:number,hasAcceptanceProof:boolean):DeliveryState{
  if(status>=200&&status<300&&hasAcceptanceProof)return 'ACCEPTED';
  if(status===409&&hasAcceptanceProof)return 'ACCEPTED';
  if(status===429||status===400||status===401||status===403||status===404)return 'REJECTED';
  return 'UNKNOWN';
}

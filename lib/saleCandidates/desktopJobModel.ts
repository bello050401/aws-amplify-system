import {createHash, randomUUID} from 'node:crypto';
import {titleWithoutNotes} from '../listing/econveni/manualSyncModel';

export const DESKTOP_RETRY_MS = 6 * 60 * 60 * 1000;
export const DESKTOP_MAX_ATTEMPTS = 4;
const LEASE_MS = 15 * 60 * 1000;
export type DesktopRequest = {
 purpose:'IDENTIFY_SALE'|'VERIFY_SALE'|'STOCK';candidateId:string;inventoryId:string;inventoryVersion:string;
 externalId:string;title:string;imageKeys:string[];orderId:string;orderLineId:string;
 targetQuantity?:number;orderUrl?:string;shopId?:string;soldQuantity?:number;unitPrice?:number;
 /** Server-created stock identity proof. Absent on legacy receipts. */
 inventoryFingerprint?:string;
};
export type DesktopEvidence = {
 snapshot:string;externalId:string;inventoryId:string;orderId:string;orderLineId:string;
 observedTitle:string;expectedImageKey:string;titleMatched:boolean;imageMatched:boolean;
 /** A retained screenshot/artifact reference, not the expected product photo URL. */
 observedEvidenceRef:string;observedAt:string;observedQuantity?:number;observedState?:'ACTIVE'|'STOPPED';inventoryVersion?:string;
};
export type DesktopJob = DesktopRequest & {
 pk:string;id:string;snapshot:string;version:string;state:'WAITING'|'CLAIMED'|'WRITE_STARTED'|'COMPLETE'|'ATTENTION';
 createdAt:string;updatedAt:string;nextAt:number;attempts:number;actor?:string;lease?:string;leaseUntil?:number;
 writeStartedAt?:string;completedAt?:string;reason?:string;evidence?:DesktopEvidence;preWriteEvidence?:DesktopEvidence;
 lastIssue?:{code:DesktopIssueCode;actor:string;at:string};
};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const desktopJobId=(r:Pick<DesktopRequest,'purpose'|'candidateId'|'externalId'>)=>hash(['BELLO_DESKTOP_V1',r.purpose,r.candidateId,r.externalId]);
export const desktopSnapshot=(r:DesktopRequest)=>hash([r.purpose,r.candidateId,r.inventoryId,r.inventoryVersion,r.externalId,r.title,r.imageKeys,r.orderId,r.orderLineId,r.targetQuantity??null,r.orderUrl??null,r.shopId??null,r.soldQuantity??null,r.unitPrice??null,...(r.inventoryFingerprint?[r.inventoryFingerprint]:[])]);
export const comparableDesktopTitle=(s:string)=>titleWithoutNotes(s.normalize('NFKC')).replace(/\s+/g,' ').trim();
/** Called only together with the immutable Yahoo settlement proof. IDs/photos/quantity stay exact. */
export const desktopCausalSnapshotMatches=(old:DesktopJob,request:DesktopRequest)=>!!comparableDesktopTitle(old.title)&&comparableDesktopTitle(old.title)===comparableDesktopTitle(request.title)&&desktopSnapshot({...request,inventoryVersion:old.inventoryVersion,title:old.title,inventoryFingerprint:old.inventoryFingerprint})===old.snapshot;
export function newDesktopJob(r:DesktopRequest,now:number):DesktopJob {
 if(!/^[a-f0-9]{64}$/.test(r.candidateId)||!r.inventoryId||!r.inventoryVersion||!r.title||!r.externalId||r.externalId.length>200||!r.orderId||r.purpose!=='IDENTIFY_SALE'&&!r.imageKeys.length||r.imageKeys.length>20||r.imageKeys.some(k=>!k||k.length>1000)||r.purpose==='STOCK'&&(!Number.isSafeInteger(r.targetQuantity)||r.targetQuantity!<0))throw Error('DESKTOP_INPUT_REQUIRED');
 const id=desktopJobId(r),at=new Date(now).toISOString();
 return {...r,id,pk:'SALE_DESKTOP#'+id,snapshot:desktopSnapshot(r),version:randomUUID(),state:'WAITING',createdAt:at,updatedAt:at,nextAt:now+DESKTOP_RETRY_MS,attempts:1};
}
export function ageDesktopJob(job:DesktopJob,now:number):DesktopJob {
 if(job.state==='ATTENTION'&&job.lastIssue&&job.reason==='DESKTOP_UNAVAILABLE')return {...job,reason:desktopIssueDiagnostic(job.lastIssue.code),updatedAt:new Date(now).toISOString(),version:randomUUID()};
 if(job.state==='COMPLETE'||job.state==='ATTENTION'||job.state==='WRITE_STARTED')return job;
 if(job.state==='CLAIMED') {
  if((job.leaseUntil??0)>now)return job;
  job={...job,state:'WAITING',actor:undefined,lease:undefined,leaseUntil:undefined,updatedAt:new Date(now).toISOString(),version:randomUUID(),reason:job.lastIssue?desktopIssueDiagnostic(job.lastIssue.code):'DESKTOP_CLAIM_EXPIRED'};
 }
 // A restarted PC/expired claim must not move the four availability windows.
 // Also normalize older receipts whose previous claim already shifted nextAt.
 const createdAt=Date.parse(job.createdAt),nextAt=createdAt+job.attempts*DESKTOP_RETRY_MS;
 if(!Number.isFinite(nextAt))return {...job,state:'ATTENTION',reason:'DESKTOP_TIME_UNKNOWN',updatedAt:new Date(now).toISOString(),version:randomUUID()};
 if(job.nextAt!==nextAt)job={...job,nextAt,updatedAt:new Date(now).toISOString(),version:randomUUID()};
 if(job.nextAt>now)return job;
 // Each due window is one availability attempt; no new instruction ID is created.
 const windows=Math.floor((now-job.nextAt)/DESKTOP_RETRY_MS)+1;
 const attempts=job.attempts+windows;
 return {...job,attempts:Math.min(attempts,DESKTOP_MAX_ATTEMPTS),state:attempts>DESKTOP_MAX_ATTEMPTS?'ATTENTION':'WAITING',nextAt:job.nextAt+windows*DESKTOP_RETRY_MS,reason:job.lastIssue?desktopIssueDiagnostic(job.lastIssue.code):attempts>DESKTOP_MAX_ATTEMPTS?'DESKTOP_UNAVAILABLE':undefined,updatedAt:new Date(now).toISOString(),version:randomUUID()};
}
export function claimDesktopJob(job:DesktopJob,actor:string,now:number):DesktopJob {
 if(!actor||job.state==='COMPLETE'||job.state==='ATTENTION')throw Error('DESKTOP_NOT_CLAIMABLE');
 if((job.state==='CLAIMED'||job.state==='WRITE_STARTED')&&(job.leaseUntil??0)>now){if(job.actor!==actor)throw Error('DESKTOP_BUSY');return job;}
 return {...job,state:job.writeStartedAt?'WRITE_STARTED':'CLAIMED',actor,lease:randomUUID(),leaseUntil:now+LEASE_MS,version:randomUUID(),updatedAt:new Date(now).toISOString()};
}
export function assertDesktopLease(job:DesktopJob,actor:string,lease:string,now:number) {
 if(!actor||job.actor!==actor||job.lease!==lease||(job.leaseUntil??0)<=now||!['CLAIMED','WRITE_STARTED'].includes(job.state))throw Error('DESKTOP_LEASE_CHANGED');
}
export function startDesktopWrite(job:DesktopJob,actor:string,lease:string,evidence:DesktopEvidence,now:number):DesktopJob {
 assertDesktopLease(job,actor,lease,now);
 if(job.purpose!=='STOCK'||job.state!=='CLAIMED'||job.writeStartedAt)throw Error('DESKTOP_RECONCILE_ONLY');
 assertDesktopIdentity(job,evidence,now);
 return {...job,state:'WRITE_STARTED',preWriteEvidence:evidence,writeStartedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),version:randomUUID()};
}
export function assertDesktopIdentity(job:DesktopJob,e:DesktopEvidence,now:number) {
 if(!e||typeof e!=='object')throw Error('DESKTOP_EVIDENCE_MISMATCH');
 if(['snapshot','externalId','inventoryId','orderId','orderLineId','observedTitle','expectedImageKey','observedEvidenceRef','observedAt'].some(k=>typeof e[k as keyof DesktopEvidence]!=='string'))throw Error('DESKTOP_EVIDENCE_MISMATCH');
 const observed=Date.parse(e.observedAt);
 const identity=job.purpose==='IDENTIFY_SALE'?!!e.externalId&&!!e.inventoryId&&!!e.inventoryVersion&&!!e.expectedImageKey:e.externalId===job.externalId&&e.inventoryId===job.inventoryId&&job.imageKeys.includes(e.expectedImageKey);
 if(e.snapshot!==job.snapshot||!identity||e.orderId!==job.orderId||e.orderLineId!==job.orderLineId||e.titleMatched!==true||e.imageMatched!==true||typeof e.observedTitle!=='string'||!comparableDesktopTitle(job.title)||comparableDesktopTitle(e.observedTitle)!==comparableDesktopTitle(job.title)||typeof e.observedEvidenceRef!=='string'||e.observedEvidenceRef.length<8||e.observedEvidenceRef.length>1000||job.imageKeys.includes(e.observedEvidenceRef)||e.observedEvidenceRef===e.expectedImageKey||/^https?:/i.test(e.observedEvidenceRef)&&!/^https:\/\//.test(e.observedEvidenceRef)||!Number.isFinite(observed)||observed>now+300000||observed<Math.max(Date.parse(job.createdAt),now-30*60*1000))throw Error('DESKTOP_EVIDENCE_MISMATCH');
}
export function finishDesktopJob(job:DesktopJob,actor:string,lease:string,e:DesktopEvidence,now:number):DesktopJob {
 // Lost completion acknowledgements are idempotent, but cannot replace the saved evidence.
 if(job.state==='COMPLETE'){if(job.actor!==actor||job.lease!==lease||hash(e)!==hash(job.evidence))throw Error('DESKTOP_RECEIPT_CHANGED');return job;}
 assertDesktopLease(job,actor,lease,now);
 assertDesktopIdentity(job,e,now);
 const observed=Date.parse(e.observedAt);
 if(job.purpose==='STOCK'&&(e.observedQuantity!==job.targetQuantity||job.targetQuantity===0&&e.observedState!=='STOPPED'||!['ACTIVE','STOPPED'].includes(e.observedState??'')||job.writeStartedAt&&(observed<Date.parse(job.writeStartedAt)||e.observedEvidenceRef===job.preWriteEvidence?.observedEvidenceRef)))throw Error('DESKTOP_READBACK_REQUIRED');
 return {...job,state:'COMPLETE',evidence:e,completedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),version:randomUUID()};
}
export const DESKTOP_ISSUE_CODES=['AUTH_REQUIRED','RATE_LIMITED','REMOTE_FORMAT_CHANGED','DESKTOP_OPERATION_FAILED','TITLE_MISMATCH','IMAGE_CHANGED','INVENTORY_CHANGED','ORDER_CHANGED','BINDING_REQUIRED','SAVE_CONFLICT','RECORDED_SALE_CHECK_FAILED'] as const;
export type DesktopIssueCode=typeof DESKTOP_ISSUE_CODES[number];
export function recordDesktopIssue(job:DesktopJob,actor:string,lease:string,code:unknown,now:number):DesktopJob {
 assertDesktopLease(job,actor,lease,now);
 if(!(DESKTOP_ISSUE_CODES as readonly unknown[]).includes(code))throw Error('DESKTOP_ISSUE_INVALID');
 return {...job,lastIssue:{code:code as DesktopIssueCode,actor,at:new Date(now).toISOString()},reason:desktopIssueDiagnostic(code as DesktopIssueCode),version:randomUUID(),updatedAt:new Date(now).toISOString()};
}
export function desktopIssueDiagnostic(code:DesktopIssueCode):string {
 return code==='REMOTE_FORMAT_CHANGED'?'DESKTOP_REMOTE_FORM_CHANGED':code==='DESKTOP_OPERATION_FAILED'?code:'DESKTOP_'+code;
}
/** Safe finite diagnostics only; stale/foreign leases and completed receipts do not create repair work. */
export function desktopSaveFailureIssue(error:unknown):DesktopIssueCode|null {
 const e=error as {name?:string;message?:string;code?:string},code=e?.message;
 if(['AUTH_REQUIRED','ACCESS_DENIED','ADDITIONAL_AUTH'].includes(e?.code??''))return 'AUTH_REQUIRED';
 if(e?.code?.startsWith('SALE_BINDING_'))return 'BINDING_REQUIRED';
 if(['ConditionalCheckFailedException','TransactionCanceledException'].includes(e?.name??''))return 'SAVE_CONFLICT';
 if(code==='DESKTOP_TITLE_MISMATCH')return 'TITLE_MISMATCH';
 if(code==='DESKTOP_IMAGE_CHANGED')return 'IMAGE_CHANGED';
 if(code==='DESKTOP_STALE_INVENTORY')return 'INVENTORY_CHANGED';
 if(code==='DESKTOP_ORDER_CHANGED')return 'ORDER_CHANGED';
 if(code==='MERCARI_RECORDED_SALE_CHECK_UNAVAILABLE')return 'RECORDED_SALE_CHECK_FAILED';
 if(code==='DESKTOP_BINDING_REQUIRED'||code==='DESKTOP_BINDING_CHANGED')return 'BINDING_REQUIRED';
 if(code==='DESKTOP_EVIDENCE_MISMATCH'||code==='DESKTOP_IDENTITY_CHANGED'||code==='DESKTOP_IDENTIFICATION_CHANGED')return 'DESKTOP_OPERATION_FAILED';
 return null;
}
export function expectedDesktopBoundaryError(error:unknown):boolean {
 const e=error as {name?:string;message?:string};
 return ['ConditionalCheckFailedException','TransactionCanceledException'].includes(e?.name??'')||/^DESKTOP_(?:INPUT_REQUIRED|ID_INVALID|CURSOR_INVALID|NOT_FOUND|NOT_CLAIMABLE|BUSY|LEASE_CHANGED|RECONCILE_ONLY|EVIDENCE_MISMATCH|RECEIPT_CHANGED|READBACK_REQUIRED|STALE_INVENTORY|IDENTITY_CHANGED|ORDER_CHANGED|ORDER_ALREADY_COMPLETED|TITLE_MISMATCH|IMAGE_CHANGED|BINDING_CHANGED|BINDING_REQUIRED|IDENTIFICATION_CHANGED|ISSUE_INVALID|REBASE_FORBIDDEN)$/.test(e?.message??'');
}

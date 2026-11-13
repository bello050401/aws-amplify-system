import {planSupplierMerge} from './merge';
import {identityKey,sourceIdentity,type ExtractionRepository,type ExtractionJob} from './jobs';
import {EXTRACTION_VERSION,type ExtractionResult} from './types';

/** Only independently corroborated fields from the two observed Restage forms.
 * No ambiguous values, inferred units, or staff-edited fields pass the merge. */
export function automaticRestageResult(result:ExtractionResult){
 return result.version===EXTRACTION_VERSION&&result.source.identity.provider==='RESTAGE'&&
  result.source.complete&&result.source.targetVerified&&
  ['restage-chair-v1','restage-general-v1'].includes(result.source.format);
}
export async function applyVerifiedRestage(repo:ExtractionRepository,job:ExtractionJob,result:ExtractionResult){
 if(!automaticRestageResult(result))return;
 const current=await repo.inventory(job.identity.inventoryId);
 const identity=current&&sourceIdentity(current);
 if(!current||current.deletedAt||current.isDeleted||current.outboundBatchId||!identity||identityKey(identity)!==identityKey(job.identity))return;
 const plan=planSupplierMerge(current,result,identityKey(job.identity));
 if(!plan.applied.length)return;
 // apply performs a second read and an atomic version check. A staff save
 // between these reads remains authoritative and must never be retried blindly.
 return repo.apply(job,result,String(current.updatedAt),'SYSTEM:RESTAGE_EXTRACTION',true);
}

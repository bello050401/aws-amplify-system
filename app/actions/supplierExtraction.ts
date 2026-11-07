'use server';
import {getInventoryRole,canEditInventory,getCurrentInventoryUserEmail} from '@/lib/amplify/requireInventoryUser';
import {extractionRepository} from '@/lib/procurement/extraction/server';
import {sourceIdentity,identityKey} from '@/lib/procurement/extraction/jobs';
import {planSupplierMerge} from '@/lib/procurement/extraction/merge';
import {FIELD_MAP,AXIS_LABELS,EXTRACTION_VERSION} from '@/lib/procurement/extraction/types';
import {revalidatePath} from 'next/cache';
const valid=(id:string)=>{if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error('商品を確認してください');};
async function authorize(edit=false){const role=await getInventoryRole();if(!role||edit&&!canEditInventory(role))throw Error('この操作の権限がありません');return role;}
function error(e:unknown){const message=(e as Error)?.message||'';return /^(仕入先|商品|この|反映|資料|別の|備考|スタッフ|原資料)/.test(message)?message:'処理結果を確認できません。商品情報を変更せず、再読込して確認してください。';}
export async function getSupplierExtractionAction(id:string){
 await authorize();valid(id);
 try{const repo=extractionRepository(),[row,job]=await Promise.all([repo.inventory(id),repo.get(id)]);if(!row||row.deletedAt)throw Error('商品が見つかりません');const identity=sourceIdentity(row);if(!identity)return{ok:true as const,supported:false as const};
 const result=job?.resultKey?await repo.result(job):null,requiresReanalysis=!!result&&result.version!==EXTRACTION_VERSION;const plan=result&&!requiresReanalysis?planSupplierMerge(row,result,identityKey(identity)):null;
 return{ok:true as const,supported:true as const,job:job||null,result,requiresReanalysis,plan:plan?{patch:plan.patch,held:plan.held}:null,current:{updatedAt:String(row.updatedAt),name:String(row.name),note:String(row.note||''),fields:Object.fromEntries(Object.keys(FIELD_MAP).map(k=>[k,String(row[k]||'')]))}};
 }catch(e){return{ok:false as const,error:error(e)};}
}
export async function requestSupplierExtractionAction(id:string,expectedRevision?:string,force=false){
 await authorize(true);valid(id);
 try{const repo=extractionRepository(),row=await repo.inventory(id),identity=row&&sourceIdentity(row);if(!identity||row?.deletedAt)throw Error('仕入先との対応を確認できません');const job=await repo.request(identity,(await getCurrentInventoryUserEmail())||'STAFF',expectedRevision,force);return{ok:true as const,revision:job.revision};}
 catch(e){return{ok:false as const,error:(e as Error).name==='ConditionalCheckFailedException'?'別の画面で処理が進んでいます。再読込してください。':error(e)};}
}
export type ExtractionDecisions={dimensions:{id:string;accept:boolean;cm:string}[];remarksAccepted:boolean;remarks:string;exclude:boolean};
export async function confirmSupplierExtractionAction(id:string,revision:string,expectedUpdatedAt:string,input:ExtractionDecisions){
 await authorize(true);valid(id);
 try{
 const repo=extractionRepository(),job=await repo.get(id);if(!job||job.revision!==revision)throw Error('資料が更新されています。再読込してください');
 if(!['REVIEW','PARTIAL'].includes(job.state))throw Error('この結果は処理中または確定済みです');
 if(input.exclude){
  const {UpdateCommand}=await import('@aws-sdk/lib-dynamodb');await repo.db.send(new UpdateCommand({TableName:repo.config.table,Key:{pk:job.pk,sk:job.sk},ConditionExpression:'revision=:r AND #s=:old',UpdateExpression:'SET #s=:new, updatedAt=:at',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':r':revision,':old':job.state,':new':'EXCLUDED',':at':new Date().toISOString()}}));return{ok:true as const,state:'EXCLUDED'};
 }
 const result=await repo.result(job);if(!result.source.targetVerified||!result.source.complete)throw Error('原資料と対象商品を確定できないため自動転記を保留しています');
 if(!Array.isArray(input.dimensions)||input.dimensions.length>100||new Set(input.dimensions.map(d=>d.id)).size!==input.dimensions.length||typeof input.remarks!=='string'||input.remarks.length>24000)throw Error('反映内容を確認してください');
 for(const d of input.dimensions)if(!result.dimensions.some(c=>c.id===d.id&&c.axis in FIELD_MAP))throw Error('反映する寸法を確認してください');
 result.dimensions=result.dimensions.map(d=>{const v=input.dimensions.find(v=>v.id===d.id);if(!v?.accept)return{...d,disposition:'EXCLUDE'};
  if(!/^\d+(?:\.\d{1,6})?$/.test(v.cm)||!Number.isFinite(Number(v.cm))||Number(v.cm)<=0||Number(v.cm)>100000)throw Error('反映する寸法をcmで入力してください');
  return{...d,mm:Number(v.cm)*10,value:Number(v.cm),unit:'cm',raw:AXIS_LABELS[d.axis]+' '+v.cm+'cm（確認値）',condition:'',disposition:'ACCEPT',reason:'原資料をスタッフが確認'};
 });
 result.remarks=input.remarksAccepted&&input.remarks.trim()?[{blockId:'remarks',text:input.remarks,disposition:'ACCEPT',reason:'原資料をスタッフが確認'}]:[];
 // No ambiguous diagram/checkbox interpretation is adopted implicitly.
 result.defects=[];
 const r=await repo.apply(job,result,expectedUpdatedAt,(await getCurrentInventoryUserEmail())||'STAFF');
 revalidatePath('/inventory/'+id);revalidatePath('/inventory');return{ok:true as const,state:r.state,held:r.held};
 }catch(e){return{ok:false as const,error:error(e)};}
}

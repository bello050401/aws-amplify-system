import {recordInventorySave,moveInventoryHistory,inventoryDiff,readEditHistory,inventoryHistoryViews} from '../../../lib/inventory/reversibleHistory';
import {transformInventoryEdit} from '../../../lib/inventory/editTransform';
export const customDefinitions=[{id:'qa-color',fieldKey:'color',label:'追加・色',fieldType:'SELECT' as const,options:['赤','青'],isActive:true,required:false,sortOrder:1},{id:'qa-memo',fieldKey:'memo',label:'追加・メモ',fieldType:'TEXTAREA' as const,options:[],isActive:true,required:false,sortOrder:2}];
export const categories=[{id:'selling',name:'販売中'},{id:'new',name:'新入荷'},{id:'check',name:'市川確認'}].map((category,sortOrder)=>({...category,parentId:null,sortOrder}));
export const products=new Map(Array.from({length:60},(_,i)=>{const row:any={id:'qa-'+i,sku:'QA'+String(i).padStart(3,'0'),name:i===2?'チェア（閉じ忘れ':`チェア（展示品） ${i+1}`,quantity:5,categoryIds:i%2?['selling','new']:['selling'],categoryId:'selling',updatedAt:new Date().toISOString(),createdAt:new Date().toISOString(),revision:0,locationId:null,statusId:null,unit:null,salePrice:null,purchasePrice:null,plannedSalePrice:null,note:null,market:null,conditionRating:null,damageNotes:null,customFields:{},mainImageThumbnailKey:null};return[row.id,row];}));
const listeners=new Set<()=>void>();let version=0;
export const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export const snapshot=()=>version;
export const notify=()=>{version++;for(const fn of listeners)fn();};
const jobs=new Map<string,any>();
const identity={actor:'操作確認用',source:'一覧一括編集'};
export async function previewInventoryEdits(input:any){
 const rows=input.ids.map((id:string)=>{const old=products.get(id);try{const after=input.mode==='edit'?{...old,...transformInventoryEdit(old,input.rules).after}:moveInventoryHistory(old,input.mode,input.targetOperationId).row;const delta=inventoryDiff(old,after),fields=[...new Set(delta.map(d=>d.field))];return{id,name:old.name,sku:old.sku,state:delta.length?'CHANGE':'UNCHANGED',before:Object.fromEntries(fields.map(f=>[f,old[f]])),after:Object.fromEntries(fields.map(f=>[f,after[f]])),delta,revision:old.revision,updatedAt:old.updatedAt,undoCount:readEditHistory(old).cursor,redoCount:readEditHistory(old).entries.length-readEditHistory(old).cursor};}catch(e){return{id,name:old.name,state:'ERROR',before:{},after:{},error:(e as Error).message};}});
 const counts:any={};for(const row of rows)counts[row.state]=(counts[row.state]??0)+1;
 const job={...input,owner:'QA',actor:'QA',state:'READY',count:input.ids.length,counts};jobs.set(input.id,{job,rows});return{...job,state:'PREPARING'};
}
export async function inventoryEditJobStatus(id:string){return structuredClone(jobs.get(id));}
export async function applyInventoryEdits(id:string){const {job,rows}=jobs.get(id);for(const row of rows){if(row.state!=='CHANGE')continue;const old=products.get(row.id);if(old.revision!==row.revision){row.state='CONFLICT';continue;}const next=job.mode==='edit'?recordInventorySave(old,{...old,...row.after},{id:crypto.randomUUID(),operationId:id,...identity,at:new Date().toISOString()}).row:moveInventoryHistory(old,job.mode,job.targetOperationId).row;products.set(row.id,{...next,updatedAt:new Date().toISOString()});row.state='SAVED';}job.state='DONE';job.counts={};for(const row of rows)job.counts[row.state]=(job.counts[row.state]??0)+1;return{...job,state:'APPLYING'};}
export async function cancelInventoryEdits(id:string){jobs.get(id).job.state='CANCELLED';}
export async function inventoryEditSelection(ids:string[]){return ids.map(id=>products.get(id));}
export async function inventoryRecentHistory(ids:string[]){return ids.map(id=>{const row=products.get(id);return {...row,history:readEditHistory(row),views:inventoryHistoryViews(row)};});}
export async function inventoryEditOperationTargets(id:string){return{id,ids:jobs.get(id).job.ids};}
export async function bulkUpdateInventoryListFields(items:any[],operationId:string){const results=items.map(item=>{const old=products.get(item.id),{customFieldChanges,...scalar}=item.changes,next=recordInventorySave(old,{...old,...scalar,customFields:{...old.customFields,...customFieldChanges}},{id:crypto.randomUUID(),operationId,actor:'操作確認用',source:'直接編集',at:new Date().toISOString()}).row;products.set(item.id,{...next,updatedAt:new Date().toISOString()});return{id:item.id,success:true,changed:true,updatedAt:products.get(item.id).updatedAt};});notify();return results;}

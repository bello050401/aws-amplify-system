import {products,notify} from '../inventory-edit-ui/store';
export async function inventorySelectionDetails(ids:string[]){return {canDelete:true,items:ids.map(id=>({...products.get(id),barcode:'2026042311254',reserved:false}))};}
const jobs=new Map<string,any>();
export async function startInventorySelectionDelete(id:string,targets:any[],confirmed:boolean){if(!confirmed)throw Error('confirmation');if(jobs.has(id))return jobs.get(id);const r={id,state:'RUNNING',total:targets.length,done:0,items:targets.map(t=>({...t,state:'PENDING'}))};jobs.set(id,r);setTimeout(()=>{for(const t of r.items){products.delete(t.id);t.state='SAVED';}r.state='COMPLETE';r.done=r.total;notify();},2000);return structuredClone(r);}
export async function inventorySelectionDeleteStatus(id:string){if(!jobs.has(id))throw Error('確認用画面の記録は再読み込みで消えます');return structuredClone(jobs.get(id));}
export const resumeInventorySelectionDelete=inventorySelectionDeleteStatus;
export async function findTransferTargets(q:string){const items=[...products.values()].filter(r=>r.name.includes(q)||r.sku.includes(q)).slice(0,30).map(r=>({...r,location:'検証倉庫',image:null}));return {total:items.length,items};}
export async function transferInventoryQuantity(r:any){const a=products.get(r.sourceId),b=products.get(r.targetId);a.quantity-=r.quantity;b.quantity+=r.quantity;notify();return {source:a.quantity,target:b.quantity};}
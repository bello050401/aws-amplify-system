import {inventoryCategoryIds} from '@/lib/inventory/categories';
import type {WholesaleRow} from './wholesale';
import type {ManualSyncData} from './econveni/manualSyncModel';
import type {EconveniWorkflow} from './econveni/workflowStore';
type Stock=Record<string,unknown>;
const amount=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
function object(v:unknown):Record<string,unknown>{try{return typeof v==='string'?object(JSON.parse(v)):v&&typeof v==='object'&&!Array.isArray(v)?v as Stock:{};}catch{return {};}}
/** purchasePrice is the final per-item cost; never add shipping again. */
export function wholesaleAmounts(item:Stock){
 const totalCost=amount(item.purchasePrice),custom=object(item.customFields),source=object(custom.__yahooPurchaseImport);
 const importedShipping=amount(source.shipping),importedQuantity=amount(source.quantity);
 const rawShipping=item.shippingCost==null||item.shippingCost===''?0:amount(item.shippingCost);
 // Yahoo imports store shipping for the original lot, while purchasePrice is per item.
 const hasStoredShipping=item.shippingCost!=null&&item.shippingCost!=='';
 const useSource=!!source.auctionId&&importedShipping!==null&&(!hasStoredShipping||rawShipping===importedShipping);
 const shipping=useSource
   ?importedShipping===0?0:importedQuantity&&Number.isSafeInteger(importedQuantity)?importedShipping!/importedQuantity:null
   :rawShipping===0?0:null;
 return {totalCost,shipping,purchaseAmount:totalCost!==null&&shipping!==null&&totalCost>=shipping?totalCost-shipping:null};
}
export function activeWholesaleBindings(manual:ManualSyncData,flows:EconveniWorkflow[]){
 const owners=new Map<string,Set<string>>();
 const add=(p:string,id:string)=>owners.set(p,new Set([...(owners.get(p)??[]),id]));
 manual.links.filter(l=>!l.disabled).forEach(l=>add(l.productId,l.inventoryId));
 flows.forEach(w=>{if(w.save.productId)add(w.save.productId,w.inventoryId);});
 const active=(manual.snapshot?.products??[]).filter(p=>Object.values(p.channels).some(c=>c.state==='ACTIVE'));
 let unlinkedCount=0,ambiguousCount=0;
 const bindings=new Map<string,{productIds:string[];imageUrl:string|null}>();
 for(const p of active){const ids=[...(owners.get(p.productId)??[])];
  if(!ids.length){unlinkedCount++;continue;}if(ids.length>1){ambiguousCount++;continue;}
  const prior=bindings.get(ids[0]);bindings.set(ids[0],{productIds:[...(prior?.productIds??[]),p.productId],imageUrl:prior?.imageUrl??p.imageUrl});
 }
 return {bindings,unlinkedCount,ambiguousCount};
}
export function wholesaleRow(item:Stock,imageUrl:string|null,wholesaleId:string|undefined,now=Date.now()):WholesaleRow|null{
 if(item.isDeleted||item.deletedAt||item.listingPartition==='MERGED'||amount(item.quantity)===0||item.saleEndDate)return null;
 const start=typeof item.saleStartDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(item.saleStartDate)&&Number.isFinite(Date.parse(item.saleStartDate))?item.saleStartDate:null;
 const today=new Date(now+9*3600000).toISOString().slice(0,10);
 const days=start?Math.floor((Date.parse(today)-Date.parse(start))/86400000):null;
 return {id:String(item.id),name:String(item.name??''),displayId:String(item.displayId??item.sku??''),imageUrl,
  updatedAt:String(item.updatedAt??''),...wholesaleAmounts(item),quantity:amount(item.quantity),saleStartDate:start,
  sellingDays:days!==null&&days>=0?days:null,alreadyWholesale:!!wholesaleId&&inventoryCategoryIds(item).includes(wholesaleId)};
}

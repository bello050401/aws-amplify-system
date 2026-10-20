import {parseCustomFields,stringifyCustomFields} from '@/lib/inventory/customFieldsCodec';
import {withHumanEdits} from '@/lib/inventory/humanEdits';

export const MERGED_PARTITION='MERGED';
export const NOT_MERGED_FILTER={or:[{listingPartition:{attributeExists:false}},{listingPartition:{ne:MERGED_PARTITION}}]};
export function mergedInventoryTarget(custom:unknown):string|null {
 const merge=parseCustomFields(custom)?.__belloStockMerge;
 return merge&&typeof merge==='object'&&'inventoryId' in merge&&typeof merge.inventoryId==='string'?merge.inventoryId:null;
}
/** Only barcode + title identify an item for consolidation; keep the destination's other fields. */
export function matchesOutboundMerge(source:Record<string,unknown>,target:Record<string,unknown>,locationId:string):boolean {
 return source.id!==target.id&&!target.deletedAt&&target.listingPartition!==MERGED_PARTITION&&target.locationId===locationId&&
  typeof source.barcode==='string'&&source.barcode.trim()!==''&&source.barcode===target.barcode&&
  typeof source.name==='string'&&source.name.trim()!==''&&source.name===target.name;
}
export function mergeQuantities(source:Record<string,unknown>,target:Record<string,unknown>,moved:number){
 const available=Number(source.quantity),before=Number(target.quantity);
 if(!Number.isSafeInteger(available)||!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(moved)||moved<1||moved>available||(!Number.isSafeInteger(before+moved)||before+moved>2_147_483_647))throw Error('合算する数量を確認してください。');
 return {remaining:available-moved,before,after:before+moved};
}
export function mergedSourceCustom(source:Record<string,unknown>,changes:Record<string,unknown>,targetId:string,batchId:string,now:string){
 const previous=parseCustomFields(source.customFields)??{};
 return stringifyCustomFields(withHumanEdits(source,changes,previous,{...previous,__belloStockMerge:{inventoryId:targetId,batchId,mergedAt:now}}));
}

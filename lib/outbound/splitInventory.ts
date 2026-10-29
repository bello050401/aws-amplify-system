import {ALL_EXTENDED_FIELDS} from '@/lib/inventory/extendedFields';
import {productCustomFields,withHumanEdits} from '@/lib/inventory/humanEdits';
import {parseCustomFields,stringifyCustomFields} from '@/lib/inventory/customFieldsCodec';
import type {OutboundBatch,OutboundRow} from './types';
import {parseJsonField,exportProductName} from './types';
import {preservesOutboundClassification} from './inventoryPolicy';

export function splitInventoryRecord(source:Record<string,unknown>,item:OutboundRow,batch:OutboundBatch,categoryIds:string[],actor:string,now:string){
 if(!item.splitInventoryId||!item.splitSku||!item.splitPrepared)throw Error('移動分の写真と商品情報を準備できていません。');
 const excluded=new Set(['salePrice','saleEndDate','market','externalProductId','saleCommission','purchaseQuantity','dailyPurchaseTotal']);
 const keys=['name','statusId','unit','note','purchasePrice',...ALL_EXTENDED_FIELDS.map(f=>f.key)];
 const fields=Object.fromEntries(keys.filter(key=>!excluded.has(key)&&source[key]!=null).map(key=>[key,source[key]]));
 const custom={...productCustomFields(parseCustomFields(source.customFields)),outboundName:exportProductName(item.snapshot),__belloStockSplit:{sourceInventoryId:source.id,batchId:batch.id,orderNumber:batch.orderNumber}};
 return {...fields,id:item.splitInventoryId,sku:item.splitSku,barcode:item.snapshot.barcode,quantity:item.snapshot.quantity,
  categoryIds,...(categoryIds[0]?{categoryId:categoryIds[0]}:{}),locationId:preservesOutboundClassification(batch)?source.locationId:batch.locationId,
  ...(preservesOutboundClassification(batch)?{outboundArrivalBatchId:batch.id}:{}),
  images:parseJsonField(item.splitImages,[]),customFields:stringifyCustomFields(custom),sourceSystem:'BELLO',
  purchaseQuantity:0,dailyPurchaseTotal:0,listingPartition:'ACTIVE',listUpdatedAt:now,
  createdAt:now,updatedAt:now,createdBy:actor,updatedBy:actor,__typename:'Inventory'};
}
export function remainingCustomFields(source:Record<string,unknown>,quantity:number){
 const previous=parseCustomFields(source.customFields);
 return stringifyCustomFields(withHumanEdits(source,{quantity},previous,previous??{}));
}
/** The accepted dispatch name belongs to the moved stock, never the remaining stock. */
export function dispatchedCustomFields(source:Record<string,unknown>,item:OutboundRow){
 const previous=parseCustomFields(source.customFields);
 return stringifyCustomFields(withHumanEdits(source,{},previous,{...previous,outboundName:exportProductName(item.snapshot)}));
}

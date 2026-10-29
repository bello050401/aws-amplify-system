import {randomUUID} from 'node:crypto';
import type {TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import type {PriceEntryRecord} from './plannedPriceCore';
export function priceEntryWriteItems(before:PriceEntryRecord,patch:Record<string,unknown>,who:string,table:(name:string)=>string):TransactWriteCommandInput['TransactItems']{
 const entries=Object.entries(patch),at=String(patch.updatedAt);
 const fields=entries.filter(([k])=>['name','note','plannedSalePrice'].includes(k));
 return [{Update:{TableName:table('Inventory'),Key:{id:before.id},
   UpdateExpression:'SET '+entries.map((_,i)=>`#p${i} = :p${i}`).join(', '),ExpressionAttributeNames:Object.fromEntries(entries.map(([key],i)=>[`#p${i}`,key])),
   ExpressionAttributeValues:{...Object.fromEntries(entries.map(([,value],i)=>[`:p${i}`,value])),':version':before.updatedAt},ConditionExpression:'updatedAt = :version AND attribute_not_exists(deletedAt) AND attribute_not_exists(outboundBatchId)'}},
   ...fields.map(([key,value])=>({Put:{TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId:before.id,changedAt:at,changedBy:who,fieldName:({name:'商品名',note:'備考',plannedSalePrice:'販売予定価格'} as Record<string,string>)[key]+'（販売予定価格入力）',oldValue:before[key]==null?'':String(before[key]),newValue:value==null?'':String(value),createdAt:at,updatedAt:at,__typename:'InventoryHistory'}}}))];
}
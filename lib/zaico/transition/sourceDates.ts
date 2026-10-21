import type {UpdateCommandInput} from '@aws-sdk/lib-dynamodb';
import type {Row} from './mapping';
import type {V2Inventory} from './v2Client';
function iso(value:unknown):string|undefined {
  return typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():undefined;
}
/** ZAICO's screen sorts update_date; updated_at also advances for internal
 * maintenance and must only be used as a fallback for older API responses. */
export function sourceDatePatch(local:Row,remote:V2Inventory,includeUpdated:boolean):Row {
  const patch:Row={};
  const createdAt=iso(remote.created_at);
  const listUpdatedAt=iso(remote.update_date)??iso(remote.updated_at);
  if(createdAt&&createdAt!==local.createdAt)patch.createdAt=createdAt;
  if(includeUpdated&&listUpdatedAt&&listUpdatedAt!==local.listUpdatedAt)patch.listUpdatedAt=listUpdatedAt;
  return patch;
}
/** Date repair does not invalidate an open editor or enqueue an outbound update. */
export function sourceDatesUpdate(table:string,local:Row,remote:V2Inventory,includeUpdated:boolean):UpdateCommandInput|null {
  if(!local.updatedAt||remote.deleted||local.sourceSystem!=='ZAICO'||String(local.sourceInventoryId)!==String(remote.id))return null;
  const patch=sourceDatePatch(local,remote,includeUpdated),keys=Object.keys(patch);
  if(!keys.length)return null;
  return {TableName:table,Key:{id:local.id},
    UpdateExpression:'SET '+keys.map((key,index)=>`#d${index} = :d${index}`).join(', '),
    ConditionExpression:'updatedAt = :version AND sourceInventoryId = :source AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(deletedAt) AND (attribute_not_exists(listingPartition) OR listingPartition <> :merged)',
    ExpressionAttributeNames:Object.fromEntries(keys.map((key,index)=>[`#d${index}`,key])),
    ExpressionAttributeValues:{':version':local.updatedAt,':source':String(remote.id),':merged':'MERGED',...Object.fromEntries(keys.map((key,index)=>[`:d${index}`,patch[key]]))},ReturnValues:'ALL_NEW'};
}

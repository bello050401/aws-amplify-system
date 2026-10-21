import type {UpdateCommandInput} from '@aws-sdk/lib-dynamodb';

/** Attaching a provider ID is bookkeeping, not a product edit. Keep both the
 * visible sort timestamp and the edit version unchanged so an open editor or
 * delete confirmation does not become stale solely because sync completed.
 * This narrow update cannot write product fields and still checks the version
 * in case a real edit, reservation, merge or deletion raced with linking. */
export function sourceIdentityUpdate(table:string,row:Record<string,unknown>,expected?:string):UpdateCommandInput|null {
  if(!expected||!row.id||row.sourceSystem!=='ZAICO'||typeof row.sourceInventoryId!=='string'||!/^\d+$/.test(row.sourceInventoryId)||
    Object.keys(row).some(key=>!['id','sourceSystem','sourceInventoryId'].includes(key)))return null;
  return {
    TableName:table,Key:{id:row.id},
    UpdateExpression:'SET sourceSystem = :system, sourceInventoryId = :source',
    ConditionExpression:'updatedAt = :version AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(deletedAt) AND (attribute_not_exists(listingPartition) OR listingPartition <> :merged) AND (attribute_not_exists(sourceInventoryId) OR sourceInventoryId = :source)',
    ExpressionAttributeValues:{':system':'ZAICO',':source':row.sourceInventoryId,':version':expected,':merged':'MERGED'},
    ReturnValues:'ALL_NEW',
  };
}

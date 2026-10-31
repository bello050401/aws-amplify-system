import {BatchGetCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {TableKey} from './keys';

export const photoRowKey=(key:TableKey)=>JSON.stringify([key.PK,key.SK]);

/** Authorize at the caller. Missing items are absent; throttled reads are retried
 * and never mistaken for missing/deleted photographs. */
export async function readPhotoRows(db:Pick<DynamoDBDocumentClient,'send'>,table:string,keys:readonly TableKey[],pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){
 const unique=[...new Map(keys.map(k=>[photoRowKey(k),k])).values()];
 const rows=new Map<string,Record<string,unknown>>();
 for(let offset=0;offset<unique.length;offset+=100){
  let pending=unique.slice(offset,offset+100);
  for(let attempt=0;pending.length;attempt++){
   if(attempt>=5)throw Error('PHOTO_BATCH_READ_INCOMPLETE');
   if(attempt)await pause(50*2**(attempt-1));
   const requested=new Set(pending.map(photoRowKey));
   const result=await db.send(new BatchGetCommand({RequestItems:{[table]:{Keys:pending,ConsistentRead:true}}}));
   for(const row of result.Responses?.[table]??[]){
    if(typeof row.PK!=='string'||typeof row.SK!=='string'||!requested.has(photoRowKey(row as TableKey)))throw Error('PHOTO_BATCH_READ_UNEXPECTED_ROW');
    rows.set(photoRowKey(row as TableKey),row);
   }
   pending=(result.UnprocessedKeys?.[table]?.Keys??[]).map(key=>{
    if(typeof key.PK!=='string'||typeof key.SK!=='string'||!requested.has(photoRowKey(key as TableKey)))throw Error('PHOTO_BATCH_READ_UNEXPECTED_KEY');
    return {PK:key.PK,SK:key.SK};
   });
  }
 }
 return rows;
}

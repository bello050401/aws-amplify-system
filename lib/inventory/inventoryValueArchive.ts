import {S3Client,ListObjectsV2Command,GetObjectCommand} from '@aws-sdk/client-s3';
import {DynamoDBDocumentClient,GetCommand,PutCommand} from '@aws-sdk/lib-dynamodb';
import {reconstructMonthEnd,monthEndBoundary,type InventoryWindow} from './inventoryValueHistory';

/** Once per closed month. Existing month records are immutable; routine page loads only read the small result. */
export async function ensureInventoryMonth(db:DynamoDBDocumentClient,month:string,links:Map<string,{id:string;sku?:string|null}>):Promise<string>{
  const table=process.env.SALES_AGGREGATE_SNAPSHOT_TABLE_NAME,bucket=process.env.INVENTORY_ARCHIVE_BUCKET,transition=process.env.ZAICO_TRANSITION_TABLE_NAME;
  if(!table||!bucket||!transition)return 'not-configured';
  const id=`inventory:${month}`;
  if((await db.send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item?.inventoryValueJson)return 'already-saved';
  const control=(await db.send(new GetCommand({TableName:transition,Key:{id:'transition#control'},ConsistentRead:true}))).Item;
  if(!control?.initialRunId)throw Error('在庫の保存記録を確認できません');
  const s3=new S3Client({}),prefix=`zaico-transition/${control.initialRunId}/remote-window/`;
  const boundary=Date.parse(monthEndBoundary(month));
  // Daily full snapshots plus all subsequent deltas. A seven-day bound fails explicitly if the baseline is unavailable.
  const files:{key:string;at:number;size:number}[]=[];let token:string|undefined;
  do{const page=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,ContinuationToken:token}));
    for(const f of page.Contents??[]){const at=f.LastModified?.getTime()??0;if(f.Key&&at>boundary-7*86400_000&&at<boundary+3600_000)files.push({key:f.Key,at,size:f.Size??0});}
    token=page.NextContinuationToken;
  }while(token);
  const load=async(key:string):Promise<InventoryWindow>=>{
    const obj=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
    const payload=JSON.parse(await obj.Body!.transformToString());const v=payload.value;
    if(!v||!Array.isArray(v.remote)||!Number.isFinite(Date.parse(v.end))||typeof v.full!=='boolean')throw Error('在庫保存記録の形式が異なります');
    return {...v,key};
  };
  // Size only orders candidates; full/end in the actual payload must verify the baseline.
  let full:InventoryWindow|undefined;
  for(const f of files.filter(f=>f.at<boundary).sort((a,b)=>b.size-a.size).slice(0,10).sort((a,b)=>b.at-a.at)){
    const w=await load(f.key);if(w.full&&Date.parse(w.end)<boundary){full=w;break;}
  }
  if(!full)throw Error('月末以前の全件記録がありません');
  const following=files.filter(f=>f.at>=Date.parse(full!.end)&&f.key!==full!.key).sort((a,b)=>a.at-b.at);
  if(following.length>2000)throw Error('月末復元の対象件数が上限を超えました');
  const windows=[full];let cursor=0;
  await Promise.all(Array.from({length:6},async()=>{while(cursor<following.length){const f=following[cursor++];windows.push(await load(f.key));}}));
  const result=reconstructMonthEnd(windows,month,links);const now=new Date().toISOString();
  try{await db.send(new PutCommand({TableName:table,Item:{id,__typename:'SalesAggregateSnapshot',generation:now,monthsJson:'[]',inventoryValueJson:JSON.stringify(result.value),sourceRecordCount:result.recordCount,rebuiltAt:now,rebuiltBy:'inventory-month-archive-v1',createdAt:now,updatedAt:now},ConditionExpression:'attribute_not_exists(id)'}));}
  catch(error){if((error as {name?:string}).name==='ConditionalCheckFailedException')return 'already-saved';throw error;}
  return 'saved';
}

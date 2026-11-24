import {GetCommand,PutCommand,ScanCommand,TransactWriteCommand,type TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import {randomUUID} from 'node:crypto';
import {ageDesktopJob,claimDesktopJob,desktopCausalSnapshotMatches,desktopJobId,desktopSnapshot,finishDesktopJob,newDesktopJob,startDesktopWrite,recordDesktopIssue,type DesktopEvidence,type DesktopJob,type DesktopRequest} from './desktopJobModel';
type DesktopCommand=GetCommand|PutCommand|ScanCommand|TransactWriteCommand;
type Db={send:(command:DesktopCommand)=>Promise<{Item?:Record<string,unknown>;Items?:Record<string,unknown>[];LastEvaluatedKey?:Record<string,unknown>}>};
type Writes=NonNullable<TransactWriteCommandInput['TransactItems']>;
export function createDesktopJobStore(db:Db,table:string,now=()=>Date.now()) {
 const get=async(id:string):Promise<DesktopJob|undefined>=>{if(!/^[a-f0-9]{64}$/.test(id))throw Error('DESKTOP_ID_INVALID');return (await db.send(new GetCommand({TableName:table,Key:{pk:'SALE_DESKTOP#'+id},ConsistentRead:true}))).Item as DesktopJob|undefined;};
 const cas=async(old:DesktopJob,next:DesktopJob)=>{
  if(old===next)return old;
  await db.send(new PutCommand({TableName:table,Item:next,ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}));return next;
 };
 const ensure=async(request:DesktopRequest)=>{
  const fresh=newDesktopJob(request,now());let saved=await get(fresh.id);
  if(!saved){try{await db.send(new PutCommand({TableName:table,Item:fresh,ConditionExpression:'attribute_not_exists(pk)'}));return {job:fresh,matches:true};}catch(error){saved=await get(fresh.id);if(!saved)throw error;}}
  const matches=saved.snapshot===desktopSnapshot(request);
  if(!matches)return {job:saved,matches:false};
  try{return {job:await cas(saved,ageDesktopJob(saved,now())),matches:true};}catch(error){const current=await get(saved.id);if(!current)throw error;return {job:current,matches:current.snapshot===fresh.snapshot};}
 };
 const claim=async(id:string,actor:string)=>{const job=await get(id);if(!job)throw Error('DESKTOP_NOT_FOUND');const aged=ageDesktopJob(job,now());if(aged.state==='ATTENTION'){await cas(job,aged);throw Error('DESKTOP_NOT_CLAIMABLE');}return cas(job,claimDesktopJob(aged,actor,now()));};
 const startWrite=async(id:string,actor:string,lease:string,evidence:DesktopEvidence,guard:{table:string;id:string;version:string},checks:Writes=[])=>{
  const old=await get(id);if(!old)throw Error('DESKTOP_NOT_FOUND');
  if(old.inventoryId!==guard.id||old.inventoryVersion!==guard.version)throw Error('DESKTOP_STALE_INVENTORY');
  const next=startDesktopWrite(old,actor,lease,evidence,now());
  await db.send(new TransactWriteCommand({TransactItems:[
   {ConditionCheck:{TableName:guard.table,Key:{id:guard.id},ConditionExpression:'updatedAt=:v',ExpressionAttributeValues:{':v':guard.version}}},
   {Put:{TableName:table,Item:next,ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}},
   {Put:{TableName:table,Item:{pk:'SALE_DESKTOP_REMOTE#'+old.externalId,jobId:old.id,state:'ACTIVE',startedAt:next.writeStartedAt},ConditionExpression:'attribute_not_exists(pk) OR #s=:released',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':released':'RELEASED'}}},...checks
  ]}));return next;
 };
 const finish=async(id:string,actor:string,lease:string,evidence:DesktopEvidence,extraWrites:Writes=[])=>{
  const old=await get(id);if(!old)throw Error('DESKTOP_NOT_FOUND');const next=finishDesktopJob(old,actor,lease,evidence,now());if(next===old)return old;
  const put={Put:{TableName:table,Item:next,ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}};
  if(old.purpose==='STOCK')await db.send(new TransactWriteCommand({TransactItems:[put,{Update:{TableName:table,Key:{pk:'SALE_DESKTOP_REMOTE#'+old.externalId},UpdateExpression:'SET #s=:released,jobId=:id,releasedAt=:at',ConditionExpression:'attribute_not_exists(pk) OR jobId=:id',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':id':old.id,':released':'RELEASED',':at':next.completedAt}}},...extraWrites]}));
  else if(extraWrites.length)await db.send(new TransactWriteCommand({TransactItems:[put,...extraWrites]}));
  else await cas(old,next);
  return next;
 };
 const list=async(cursor?:string)=>{
  let start:undefined|{pk:string};
  if(cursor){if(cursor.length>1000)throw Error('DESKTOP_CURSOR_INVALID');try{start=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw Error('DESKTOP_CURSOR_INVALID');}if(!start||Object.keys(start).join(',')!=='pk'||typeof start.pk!=='string'||start.pk.length>600)throw Error('DESKTOP_CURSOR_INVALID');}
  for(let page=0;page<8;page++){
   const r=await db.send(new ScanCommand({TableName:table,Limit:100,ExclusiveStartKey:start,FilterExpression:'begins_with(pk,:p)',ExpressionAttributeValues:{':p':'SALE_DESKTOP#'},ConsistentRead:true}));
   const jobs=(r.Items??[]) as DesktopJob[],next=r.LastEvaluatedKey;
   if(jobs.length||!next||page===7)return {jobs,cursor:next?Buffer.from(JSON.stringify(next)).toString('base64url'):null};
   start=next as {pk:string};
  }
  throw Error('DESKTOP_SCAN_UNREACHABLE');
 };
 const rebase=async(old:DesktopJob,request:DesktopRequest)=>{
  if(old.purpose!=='STOCK'||old.writeStartedAt||['COMPLETE','ATTENTION'].includes(old.state)||desktopJobId(request)!==old.id||!desktopCausalSnapshotMatches(old,request))throw Error('DESKTOP_REBASE_FORBIDDEN');
  return cas(old,{...old,...request,snapshot:desktopSnapshot(request),state:'WAITING',actor:undefined,lease:undefined,leaseUntil:undefined,version:randomUUID(),updatedAt:new Date(now()).toISOString()});
 };
 const recordIssue=async(id:string,actor:string,lease:string,code:unknown)=>{const old=await get(id);if(!old)throw Error('DESKTOP_NOT_FOUND');return cas(old,recordDesktopIssue(old,actor,lease,code,now()));};
 const holdRecordedSale=async(id:string)=>{
  const old=await get(id);if(!old||old.purpose!=='IDENTIFY_SALE'||old.state==='COMPLETE'||old.state==='WRITE_STARTED'||old.writeStartedAt||old.reason==='MERCARI_ORDER_ALREADY_RECORDED')return old;
  return cas(old,{...old,state:'ATTENTION',reason:'MERCARI_ORDER_ALREADY_RECORDED',version:randomUUID(),updatedAt:new Date(now()).toISOString()});
 };
 return {get,ensure,claim,startWrite,finish,list,rebase,recordIssue,holdRecordedSale,id:desktopJobId};
}

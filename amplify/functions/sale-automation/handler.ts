import {randomUUID} from 'node:crypto';
import {GetCommand,PutCommand,QueryCommand,UpdateCommand,type QueryCommandInput} from '@aws-sdk/lib-dynamodb';
import {S3Client} from '@aws-sdk/client-s3';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import {inventoryDdb as db,inventoryTable,getInventoryRaw} from '../../../lib/inventory/categoryPersistence';
import {createCandidateStore} from '../../../lib/saleCandidates/storeCore';
import {automaticSaleDecision} from '../../../lib/saleCandidates/automationPolicy';
import {runAutomaticSale,type AutomationJob} from '../../../lib/saleCandidates/automationCore';
import {exactListingInventoryIds} from '../../../lib/saleCandidates/listingMatch';
import {getEcListingCatalogCore} from '../../../lib/listing/ecCatalogCore';
import {reviewPostSaleCore,executePostSaleCore,type PostSalePorts} from '../../../lib/saleCandidates/postSaleCore';
import {stopListing} from '../../../lib/listing/stopService';
import {automaticYahooStop} from '../../../lib/listing/econveni/automaticYahooStop';
import {createSoldOutService} from '../../../lib/inventory/soldOutCore';
import {createYahooPaymentStockPorts} from '../../../lib/saleCandidates/yahooPaymentStock';
import {yahooPaymentPlan} from '../../../lib/saleCandidates/yahooPaymentModel';
import {parseBaseOrder} from '../../../lib/saleCandidates/baseOrders';
import {getAccessToken} from '../../../lib/base/oauth';
import type {SaleCandidate} from '../../../lib/saleCandidates/model';
import {shouldSeedAutomation} from '../../../lib/saleCandidates/automationEligibility';
import {runPostSaleJob,postSaleJobSaveRequest,type PostSaleJob} from '../../../lib/saleCandidates/postSaleQueueCore';
import type {PostSalePlan} from '../../../lib/saleCandidates/postSaleModel';
import {ECONVENI_WORKFLOW_TABLE} from '../../../lib/listing/econveni/runtimeStore';
import {processNativeQueue} from '../../../lib/listing/econveni/nativeQueue';
import {runCatalogMaintenance} from './maintenance';
import {ensureAutomaticSaleBinding} from '../../../lib/saleCandidates/saleBinding';
import {claimAutomationStock,releaseAutomationStock,automationStockGuard} from '../../../lib/saleCandidates/automationStockLock';
import {resolveMercariSale,verifyMercariSale,postSaleMercari,postSaleMercariComplete} from '../../../lib/saleCandidates/desktopJobs';
import {completeYahooSaleFacts} from '../../../lib/saleCandidates/yahooSaleFactsServer';
import {reportSaleAutomationFailure} from '../../../lib/saleCandidates/errorReporting';

const required=(name:string)=>{const v=process.env[name];if(!v)throw Error('SALE_CONFIGURATION_MISSING');return v;};
const table=()=>required('SALE_CANDIDATES_TABLE');
const actor='BELLO_SALE_AUTOMATION';
const ec:PostSalePorts={automatic:true,automaticYahooStop,releaseStock:(id,candidate)=>releaseAutomationStock(db,table(),id,candidate),desktopMercari:postSaleMercari,desktopMercariComplete:postSaleMercariComplete,catalog:id=>getEcListingCatalogCore('ADMIN',id),reviewStop:stopListing,executeStop:(r,a)=>stopListing(r.inventoryId,r.channel,a,r.token)};
const confirmedEc:PostSalePorts={...ec,automatic:false,background:true};
const machineErrors=new Set(['BASE_ORDER_VERIFY_FAILED','BASE_ORDER_CHANGED','YAHOO_SALE_AUTH_REQUIRED','YAHOO_SALE_ACCESS_DENIED','YAHOO_SALE_RATE_LIMITED','YAHOO_SALE_FORM_CHANGED','YAHOO_SALE_READ_UNAVAILABLE','SALE_RESULT_UNCONFIRMED','SALE_SKU_FAILED','SALE_CONFIGURATION_MISSING','AUTH_REQUIRED','ADDITIONAL_AUTH','SESSION_EXPIRED','RATE_LIMITED','VERIFY_REQUIRED','STATE_UNAVAILABLE','WAIT_INTERVAL','BUSY_OR_STOPPED']);
const safeCode=(e:unknown)=>{const error=e as {code?:string;name?:string;message?:string};if(error?.message&&machineErrors.has(error.message))return error.message;const v=error?.code||error?.name;return v&&/^[A-Za-z0-9_]{1,64}$/.test(v)?v:'UNCONFIRMED';};
async function get(id:string){return (await db.send(new GetCommand({TableName:table(),Key:{id},ConsistentRead:true}))).Item;}
async function freshBase(c:SaleCandidate):Promise<SaleCandidate>{
 if(c.channel!=='BASE')return c;
 if(c.source!=='BASE_API'||!/^[A-Za-z0-9_-]{1,128}$/.test(c.orderId))return c;
 const token=await getAccessToken();
 const r=await fetch('https://api.thebase.in/1/orders/detail/'+encodeURIComponent(c.orderId),{headers:{Authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('BASE_ORDER_VERIFY_FAILED');
 const raw=await r.json(); // Buyer fields stay only in this request's memory.
 if(raw.order?.dispatch_status==='cancelled'||Number(raw.order?.cancelled)>0)return {...c,baseDispatchStatus:'cancelled'};
 const fresh=parseBaseOrder(raw).find(x=>x.id===c.id);
 if(!fresh||fresh.externalListingId!==c.externalListingId||fresh.quantity!==c.quantity||fresh.unitPrice!==c.unitPrice||fresh.orderLineId!==c.orderLineId)throw Error('BASE_ORDER_CHANGED');
 return {...fresh,state:c.state,updatedAt:c.updatedAt,createdAt:c.createdAt,receivedAt:c.receivedAt};
}
export async function handler(event?:{mode?:string}){
 if(event?.mode==='CATALOG_MAINTENANCE')return runCatalogMaintenance();
 const started=Date.now(),config=await get('AUTOMATION_CONFIG');
 if(event?.mode==='PREVIEW'){
  // Private IAM invocation for deployment checks; no sale, EC command, or journal writes.
  const store=createCandidateStore(db,table()),fees=await store.config();
  const page=await db.send(new QueryCommand({TableName:table(),IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':'PENDING'},Limit:20}));
  const rows=[];
  for(const row of page.Items??[]){try{const c=await freshBase(row as SaleCandidate),ids=c.channel!=='DIRECT'?await exactListingInventoryIds(c.channel==='MERCARI'?'MERCARI_SHOPS':c.channel,c.externalListingId??''):[];
   const decision=automaticSaleDecision(c,ids,ids.length===1?(await getInventoryRaw(ids[0])??null):null,fees,config?.enabledAt??new Date().toISOString());
   rows.push({candidateId:c.id,channel:c.channel,matches:ids.length,decision:decision.kind,reason:'reason'in decision?decision.reason:null});
  }catch(e){rows.push({candidateId:row.id,error:safeCode(e)});}}
  return {mode:'PREVIEW',enabled:config?.enabled===true,rows,more:!!page.LastEvaluatedKey,photoStorageConfigured:!!process.env.PHOTO_REGISTRATION_TABLE_NAME&&!!process.env.PHOTO_REGISTRATION_BUCKET_NAME};
 }
 const owner=randomUUID();
 try{await db.send(new UpdateCommand({TableName:table(),Key:{id:'AUTOMATION_LOCK'},UpdateExpression:'SET ownerId=:o,expiresAt=:e',ConditionExpression:'attribute_not_exists(expiresAt) OR expiresAt<:n',ExpressionAttributeValues:{':o':owner,':e':started+240000,':n':started}}));}
 catch(e){if((e as Error).name==='ConditionalCheckFailedException')return {busy:true};throw e;}
 let processed=0,complete=0,attention=0;
 try{
  const nativeProcessed=await processNativeQueue(started+40000);
  if(event?.mode==='EC_NATIVE')return {nativeProcessed};
  // Staff-confirmed work is independent of mail auto-sale. The persisted request is the authority.
  const queueCursor=await get('POST_SALE_CURSOR');
  const queued=await db.send(new QueryCommand({TableName:table(),IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':'SALE_EC_ACTIVE'},Limit:20,ExclusiveStartKey:queueCursor?.cursor as QueryCommandInput['ExclusiveStartKey']}));
  let queuedProcessed=0;
  for(const indexed of queued.Items??[]){
   if(Date.now()-started>100000)break;
   // GSI may lag. Read the exact durable request before acting.
   const job=await get(indexed.id) as PostSaleJob|undefined;
   if(!job||job.state!=='SALE_EC_ACTIVE'||job.nextAt>Date.now())continue;
   let manualVersion=job.version;
   try{await runPostSaleJob(job,{
    now:Date.now,
    read:async()=> (await db.send(new GetCommand({TableName:ECONVENI_WORKFLOW_TABLE,Key:{pk:'SALE_EC#'+job.candidateId},ConsistentRead:true}))).Item as PostSalePlan|undefined,
    execute:p=>executePostSaleCore(confirmedEc,p.candidateId,job.actor,job.token,true,job.terms),
    complete:async p=>{const c=await createCandidateStore(db,table()).get(p.candidateId);if(c?.result&&!c.result.quantityDeferred)await releaseAutomationStock(db,table(),p.sourceId,p.candidateId);},
    save:async value=>{const write=postSaleJobSaveRequest(table(),value,{token:job.token,version:manualVersion});await db.send(new PutCommand(write));manualVersion=write.Item!.version as string;value.version=manualVersion;},
    attention:async(p,reason)=>{await db.send(new UpdateCommand({TableName:ECONVENI_WORKFLOW_TABLE,Key:{pk:'SALE_EC#'+p.id},UpdateExpression:'SET #s=:attention,#e=:reason,updatedAt=:now',ConditionExpression:'#t=:t AND #s=:old',ExpressionAttributeNames:{'#t':'token','#s':'state','#e':'error'},ExpressionAttributeValues:{':t':job.token,':old':p.state,':attention':'ATTENTION',':reason':reason,':now':new Date().toISOString()}}));},
   });queuedProcessed++;}catch(e){console.error('POST_SALE_WORKER_FAILED',{code:safeCode(e)});}
  }
  await db.send(new PutCommand({TableName:table(),Item:{id:'POST_SALE_CURSOR',...(queued.LastEvaluatedKey?{cursor:queued.LastEvaluatedKey}:{})}}));
  await db.send(new PutCommand({TableName:table(),Item:{id:'POST_SALE_STATUS',lastRunAt:new Date().toISOString(),processed:queuedProcessed,durationMs:Date.now()-started}}));
  if(event?.mode==='POST_SALE'||!config?.enabled||!Number.isFinite(Date.parse(config.enabledAt)))return {queuedProcessed,enabled:config?.enabled===true};
  const store=createCandidateStore(db,table()),fees=await store.config();
  const stock=createYahooPaymentStockPorts({db,table:inventoryTable,s3:new S3Client({}),inventoryBucket:required('INVENTORY_BUCKET'),photoTable:required('PHOTO_REGISTRATION_TABLE_NAME'),photoBucket:required('PHOTO_REGISTRATION_BUCKET_NAME'),nextSku:async()=>{
   const r=await new LambdaClient({}).send(new InvokeCommand({FunctionName:required('GENERATE_SKU_FUNCTION_NAME'),Payload:Buffer.from('{}')}));const sku=JSON.parse(Buffer.from(r.Payload??[]).toString());if(r.FunctionError||typeof sku!=='string'||!/^B\d+$/.test(sku))throw Error('SALE_SKU_FAILED');return sku;
  }});
  const jobs=new Map<string,AutomationJob>();
  // Read bounded cursor pages; never starve older notifications behind the first page.
  for(const state of ['PENDING','DONE','SALE_AUTO_ACTIVE','SALE_AUTO_ATTENTION']){
   const cursorKey='AUTOMATION_CURSOR:'+state,previous=await get(cursorKey);
   const page=await db.send(new QueryCommand({TableName:table(),IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':state},Limit:20,ExclusiveStartKey:previous?.cursor as QueryCommandInput['ExclusiveStartKey']}));
   await db.send(new PutCommand({TableName:table(),Item:{id:cursorKey,...(page.LastEvaluatedKey?{cursor:page.LastEvaluatedKey}:{})}}));
   for(const row of page.Items??[]){
    if(state==='PENDING'||state==='DONE'){
     if(!shouldSeedAutomation(row as SaleCandidate,config.enabledAt))continue;
     const id='AUTO:'+row.id,old=await get(id);if(old)continue;
     const now=new Date().toISOString(),job:AutomationJob={id,candidateId:row.id,state:'SALE_AUTO_ACTIVE',phase:'IDENTIFY',createdAt:now,updatedAt:now,receivedAt:row.receivedAt,attempts:0,version:randomUUID()};
     try{await db.send(new PutCommand({TableName:table(),Item:job,ConditionExpression:'attribute_not_exists(id)'}));jobs.set(job.id,job);}catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
    }else if(state==='SALE_AUTO_ACTIVE')jobs.set(row.id,row as AutomationJob);
    else {const c=await store.get(row.candidateId);if(c?.state==='DONE'&&c.completedAt&&(row.phase==='REVIEW'&&!row.saleAt||row.retryRequested)){jobs.set(row.id,{...row,state:'SALE_AUTO_ACTIVE',nextAt:0} as AutomationJob);}}
   }
  }
  for(const job of jobs.values()){
   if(Date.now()-started>140000)break;
   // Recheck kill switch before every candidate, not just at the start of a long invocation.
   if(!(await get('AUTOMATION_CONFIG'))?.enabled)break;
   let version=job.version;
   const save=async(j:AutomationJob)=>{const next=randomUUID();await db.send(new PutCommand({TableName:table(),Item:{...j,version:next},ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':version}}));version=next;j.version=next;};
   try{
    const manual=await get('EC_JOB:'+job.candidateId);
    if(manual?.state==='SALE_EC_ACTIVE')continue;
    const previous=await store.get(job.candidateId);
    if(previous?.result){
     if(!await claimAutomationStock(db,table(),previous.result.sourceId,job.candidateId))continue;
     job.inventoryId=previous.result.sourceId;
    }
    const result=await runAutomaticSale(job,{now:Date.now,candidate:()=>store.get(job.candidateId),save,decide:async current=>{
     let c=await freshBase(current);
     if(c.channel==='YAHOO'&&Date.parse(c.yahooAuthenticatedWonAt??'')>=Date.parse(config.enabledAt))c=await completeYahooSaleFacts(c,db,table());
     const ids=c.channel!=='DIRECT'?await exactListingInventoryIds(c.channel==='MERCARI'?'MERCARI_SHOPS':c.channel,c.externalListingId??''):[];
     if(c.yahooSaleEvidence?.source==='TRUSTED_NOTICE_LINKED_CLOSED_LISTING'){
      const proof=c.yahooSaleEvidence,item=ids.length===1?await getInventoryRaw(ids[0]):null;
      if(ids.length!==1||ids[0]!==proof.inventoryId||!item||item.updatedAt!==proof.inventoryVersion)return {kind:'REVIEW',reason:'STOCK_CHANGED'};
     }
     return automaticSaleDecision(c,ids,ids.length===1?(await getInventoryRaw(ids[0])??null):null,fees,config.enabledAt);
    },identify:resolveMercariSale,prepare:async(c,request)=>{
     if(!await claimAutomationStock(db,table(),request.inventoryId,c.id))return {status:'WAIT',reason:'PREVIOUS_SALE_PENDING'};
     job.inventoryId=request.inventoryId;await save(job);
     const channel=c.channel==='MERCARI'?'MERCARI_SHOPS':c.channel;
     if(channel==='DIRECT'||!await ensureAutomaticSaleBinding(request.inventoryId,channel,c.externalListingId??'',actor))return {status:'REVIEW',reason:'ECONVENI_BINDING_REQUIRED'};
     const inventory=await getInventoryRaw(request.inventoryId);
     if(!inventory||inventory.updatedAt!==request.expectedUpdatedAt)return {status:'REVIEW',reason:'STOCK_CHANGED'};
     if(c.channel==='MERCARI'){const verified=await verifyMercariSale(c,inventory);return {...verified,reason:verified.status==='DONE'?undefined:'MERCARI_DESKTOP_VERIFICATION'};}
     return {status:'DONE'};
    },sell:async(c,request)=>createSoldOutService({db,table:inventoryTable,...stock,yahooPayment:yahooPaymentPlan(c),saleCommit:(result,now)=>[...automationStockGuard(table(),request.inventoryId,c.id),...store.commit(c,actor,result,now)]})(request,actor),review:id=>reviewPostSaleCore(ec,id,actor),execute:p=>executePostSaleCore(ec,p.candidateId,actor,p.token,true,config.yahooRelistTerms===true)});
    if(result.state==='SALE_AUTO_COMPLETE'&&result.inventoryId)await releaseAutomationStock(db,table(),result.inventoryId,result.candidateId);
    if(result.state==='SALE_AUTO_ATTENTION'&&result.reason)await reportSaleAutomationFailure(result.candidateId,result.phase,result.reason);
    processed++;if(result.state==='SALE_AUTO_COMPLETE')complete++;if(result.state==='SALE_AUTO_ATTENTION')attention++;
   }catch(e){
    job.attempts++;job.reason=safeCode(e);job.updatedAt=new Date().toISOString();
    job.state=job.attempts>=3?'SALE_AUTO_ATTENTION':'SALE_AUTO_ACTIVE';job.nextAt=Date.now()+300000;
    await save(job);await reportSaleAutomationFailure(job.candidateId,job.phase,job.reason);attention++;
   }
  }
  await db.send(new PutCommand({TableName:table(),Item:{id:'AUTOMATION_STATUS',lastRunAt:new Date().toISOString(),processed,complete,attention,durationMs:Date.now()-started}}));
  return {processed,complete,attention};
 }finally{await db.send(new UpdateCommand({TableName:table(),Key:{id:'AUTOMATION_LOCK'},UpdateExpression:'SET expiresAt=:z',ConditionExpression:'ownerId=:o',ExpressionAttributeValues:{':z':0,':o':owner}}));}
}

import 'server-only';
import {randomUUID,createHash} from 'node:crypto';
import {BatchGetCommand,GetCommand,PutCommand,QueryCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {CognitoIdentityProviderClient,AdminGetUserCommand,AdminListGroupsForUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import outputs from '../../../amplify_outputs.json';
import {candidateConfig} from '@/lib/saleCandidates/store';
import {getInventoryRaw,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {parseCustomFields} from '@/lib/inventory/customFieldsCodecCore';
import {econveniDatabase as db,ECONVENI_WORKFLOW_TABLE as table,econveniStore,readEconveniCatalog} from './runtimeStore';
import {readManualSync} from './manualSync';
import {soldListingReferences} from './overviewCatalog';
import {EconveniHttpSession} from './httpSession';
import {withEconveniAccount} from './accountWorkflow';
import {econveniCredentialStore} from './credentials';
import {nativeAllowed,nativeResultMatches,type NativeRequest,type NativeJob} from './nativeModel';
import {manualLinkKey,type ExternalProduct} from './manualSyncModel';
import {markInventoryPublished} from '../publicationCategory';
export const nativeFingerprint=(remote:ExternalProduct,channel:NativeRequest['channel'])=>createHash('sha256').update(JSON.stringify({...remote,channels:{[channel]:remote.channels[channel]}})).digest('hex');
const stockFingerprint=(item:NonNullable<Awaited<ReturnType<typeof getInventoryRaw>>>)=>createHash('sha256').update(JSON.stringify([item.name,item.quantity,item.saleEndDate,item.market,item.isDeleted,item.deletedAt,item.listingPartition,parseCustomFields(item.customFields)?.__belloYahooPayment])).digest('hex');
let masterCache:{expires:number;rows:{id:string;name:string}[]}|undefined;
async function workerCategories(){if(masterCache&&masterCache.expires>Date.now())return masterCache.rows;const rows:{id:string;name:string}[]=[];let key:Record<string,unknown>|undefined;do{const r=await db.send(new ScanCommand({TableName:inventoryTable('Category'),ProjectionExpression:'id,#n,isActive',ExpressionAttributeNames:{'#n':'name'},ExclusiveStartKey:key}));rows.push(...(r.Items??[]).filter(x=>x.isActive!==false).map(x=>({id:x.id,name:x.name})));key=r.LastEvaluatedKey;}while(key);masterCache={expires:Date.now()+60000,rows};return rows;}
const queueTable=()=>candidateConfig().tableName;
const targetKey=(r:NativeRequest)=>({pk:'ECONVENI#NATIVE_TARGET#'+r.productId+'#'+r.channel});
const safeError=(e:unknown)=>e instanceof Error&&/[ぁ-んァ-ン一-龯]/.test(e.message)?e.message:'処理結果を確認できません。再取得して確認してください。';
const getJob=async(id:string)=>(await db.send(new GetCommand({TableName:queueTable(),Key:{id},ConsistentRead:true}))).Item as NativeJob|undefined;
export async function nativeShared(inventoryId?:string){const [flows,refs]=await Promise.all([readEconveniCatalog(inventoryId),soldListingReferences()]);const manual=await readManualSync(inventoryId,flows.flatMap(f=>f.save.productId?[f.save.productId]:[]));return {manual,flows,refs};}
async function legacyListing(r:NativeRequest){
 const t=inventoryTable('ChannelListing'),page=await db.send(new QueryCommand({TableName:t,IndexName:'channelListingsByInventoryId',KeyConditionExpression:'inventoryId=:id',ExpressionAttributeValues:{':id':r.inventoryId},Limit:100}));
 if(page.LastEvaluatedKey)throw Error('販売先の登録情報を確認してください。');
 const rows=(page.Items??[]).filter(x=>x.channel===r.channel);
 if(rows.length>1)throw Error('同じ販売先に複数の登録情報があります。確認してください。');
 return rows[0]?(await db.send(new GetCommand({TableName:t,Key:{id:rows[0].id},ConsistentRead:true}))).Item:undefined;
}
async function context(r:NativeRequest,shared?:Awaited<ReturnType<typeof nativeShared>>){
 const [{manual,flows,refs},item,legacy]=await Promise.all([shared??nativeShared(r.inventoryId),getInventoryRaw(r.inventoryId),legacyListing(r)]);
 const owners=new Set([...manual.links.filter(l=>l.productId===r.productId).map(l=>l.inventoryId),...flows.filter(f=>f.save.productId===r.productId).map(f=>f.inventoryId)]);
 if(owners.size!==1||!owners.has(r.inventoryId)||!item||!manual.snapshot)throw Error('商品の紐付けが変わりました。再確認してください。');
 const remote=manual.snapshot.products.find(p=>p.productId===r.productId);if(!remote)throw Error('eコンビニの商品が見つかりません。');
 const siblingIds=new Set([...manual.links.filter(l=>l.inventoryId===r.inventoryId&&l.productId!==r.productId).map(l=>l.productId),...flows.filter(f=>f.inventoryId===r.inventoryId&&f.save.productId!==r.productId).flatMap(f=>f.save.productId?[f.save.productId]:[])]);
 if(r.operation==='PUBLISH'&&manual.snapshot.products.some(p=>siblingIds.has(p.productId)&&p.channels[r.channel].state==='ACTIVE'))throw Error('同じ在庫の別ページがこの販売先に出品中です。重複出品を防ぐため停止しました。');
 if(legacy?.status==='PUBLISHING')throw Error('販売先の別の処理が進行中です。結果を確認してください。');
 if(legacy?.externalListingId&&legacy.externalListingId!==remote.channels[r.channel].listingId)throw Error('販売先の出品番号がeコンビニと一致しません。紐付けを確認してください。');
 const soldChannel=item.market==='ヤフオク'?'YAHOO':item.market==='メルカリSHOP'?'MERCARI_SHOPS':item.market==='ベイス'?'BASE':null;
 const waiting=(parseCustomFields(item.customFields)?.__belloYahooPayment as {state?:string;auctionId?:string;request?:{quantity?:number}}|undefined);
 if(waiting?.state==='WAITING'&&r.operation==='PUBLISH')throw Error('入金待ちの予約があります。入金・残り数量の確定後に出品してください。');
 const protectedSale=!!remote.channels[r.channel].listingId&&!!refs[r.inventoryId]?.[r.channel]?.includes(remote.channels[r.channel].listingId!)||!!item.saleEndDate&&soldChannel===r.channel||waiting?.state==='WAITING'&&r.channel==='YAHOO';
 const link=manual.links.find(l=>l.inventoryId===r.inventoryId&&l.productId===r.productId),workflow=flows.find(f=>f.inventoryId===r.inventoryId&&f.save.productId===r.productId);
 if(flows.some(f=>f.inventoryId===r.inventoryId&&(f.save.state==='PENDING'||f.save.state==='VERIFY_REQUIRED'||Object.values(f.channels).some(c=>['PENDING','VERIFY_REQUIRED'].includes(c.state)))))throw Error('前回のeコンビニ処理の結果を先に確認してください。');
 const bindingChecks=link?[{ConditionCheck:{TableName:table,Key:{pk:manualLinkKey(link)},ConditionExpression:'revision=:r AND productId=:p AND (attribute_not_exists(disabled) OR disabled=:no)',ExpressionAttributeValues:{':r':link.revision,':p':r.productId,':no':false}}},{ConditionCheck:{TableName:table,Key:{pk:'ECONVENI#MANUAL_OWNER#'+r.productId},ConditionExpression:'inventoryId=:id',ExpressionAttributeValues:{':id':r.inventoryId}}}]:workflow?[{ConditionCheck:{TableName:table,Key:{pk:workflow.pk},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':workflow.revision}}}]:[];
 return {manual,item,remote,protectedSale,bindingChecks,legacy,siblingIds};
}
export async function reviewNative(r:NativeRequest,shared?:Awaited<ReturnType<typeof nativeShared>>){
 const ctx=await context(r,shared),reason=nativeAllowed(r,ctx.remote,ctx.item,ctx.protectedSale);
 if(reason)throw Error(reason);
 if(Date.now()-Date.parse(ctx.manual.snapshot!.checkedAt)>30*60000)throw Error('eコンビニの状態を取得し直してから実行してください。');
 return {...r,title:ctx.remote.title,price:ctx.remote.price,quantity:ctx.remote.quantity,fingerprint:nativeFingerprint(ctx.remote,r.channel),inventoryVersion:String(ctx.item.updatedAt)};
}
export async function enqueueNative(r:NativeRequest&{requestId:string;fingerprint:string;inventoryVersion:string;confirmed:boolean;terms:boolean},actor:string,shared?:Awaited<ReturnType<typeof nativeShared>>){
 if(!r.confirmed||!/^[-a-zA-Z0-9]{8,80}$/.test(r.requestId))throw Error('確認内容を確認してください。');
 const id='EC_NATIVE:'+r.requestId,existing=await getJob(id);
 if(existing){if(existing.actor!==actor||existing.inventoryId!==r.inventoryId||existing.productId!==r.productId||existing.channel!==r.channel||existing.operation!==r.operation)throw Error('受付番号が一致しません。');return existing;}
 const review=await reviewNative(r,shared);
 if(review.fingerprint!==r.fingerprint||review.inventoryVersion!==r.inventoryVersion)throw Error('確認後に商品が変更されました。もう一度確認してください。');
 if(r.channel==='YAHOO'&&r.operation==='PUBLISH'&&!r.terms)throw Error('Yahoo!オークションのガイドラインへの同意を確認してください。');
 const ctx=await context(r,shared),now=new Date().toISOString();
 const job:NativeJob={id,actor,inventoryId:r.inventoryId,productId:r.productId,channel:r.channel,operation:r.operation,title:review.title,fingerprint:r.fingerprint,inventoryVersion:r.inventoryVersion,stockFingerprint:stockFingerprint(ctx.item),before:ctx.remote,terms:r.terms,state:'EC_NATIVE_ACTIVE',phase:'QUEUED',nextAt:0,createdAt:now,updatedAt:now,attempts:0};
 try{await db.send(new TransactWriteCommand({TransactItems:[
  {Put:{TableName:queueTable(),Item:job,ConditionExpression:'attribute_not_exists(id)'}},
  {Put:{TableName:table,Item:{...targetKey(r),jobId:id,active:true},ConditionExpression:'attribute_not_exists(active) OR active=:no',ExpressionAttributeValues:{':no':false}}},
  {ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id:r.inventoryId},ConditionExpression:'updatedAt=:v',ExpressionAttributeValues:{':v':r.inventoryVersion}}}
 ]}));}catch{const saved=await getJob(id);if(saved?.actor===actor)return saved;throw Error('この販売先は処理中か、商品が変更されました。処理結果を確認してください。');}
 if(!shared)await wakeNative();
 return job;
}
export async function wakeNative(){
 const fn=(outputs.custom as {saleAutomation?:{functionName?:string}})?.saleAutomation?.functionName;
 if(fn)try{await new LambdaClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1}).send(new InvokeCommand({FunctionName:fn,InvocationType:'Event',Payload:Buffer.from('{"mode":"EC_NATIVE"}')}),{abortSignal:AbortSignal.timeout(1200)});}catch{/* Minute scheduler recovers lost wake-up. */}
}
export async function nativeJobStatus(ids:string[]){
 const keys=[...new Set(ids)].filter(id=>/^EC_NATIVE:[-a-zA-Z0-9]{8,80}$/.test(id)).slice(0,100).map(id=>({id}));
 if(!keys.length){const pages=await Promise.all(['EC_NATIVE_ACTIVE','EC_NATIVE_ATTENTION','EC_NATIVE_DONE'].map(state=>db.send(new QueryCommand({TableName:queueTable(),IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':state},Limit:50,ScanIndexForward:false}))));return pages.flatMap(p=>p.Items??[]).map(j=>({id:j.id,productId:j.productId,channel:j.channel,operation:j.operation,title:j.title,state:j.state,phase:j.phase,reason:j.reason,updatedAt:j.updatedAt}));}
 const t=queueTable(),r=await db.send(new BatchGetCommand({RequestItems:{[t]:{Keys:keys,ConsistentRead:true}}}));
 if(r.UnprocessedKeys?.[t]?.Keys?.length)throw Error('結果を再確認してください。');
 return (r.Responses?.[t]??[]).map(j=>({id:j.id,productId:j.productId,channel:j.channel,operation:j.operation,title:j.title,state:j.state,phase:j.phase,reason:j.reason,updatedAt:j.updatedAt}));
}
/** Retry verification only. A durable send receipt never permits a second write. */
export async function recheckNative(id:string){
 if(!/^EC_NATIVE:[-a-zA-Z0-9]{8,80}$/.test(id))throw Error('処理番号を確認してください。');
 const job=await getJob(id);if(!job||job.state!=='EC_NATIVE_ATTENTION')return;
 const receipt=(await db.send(new GetCommand({TableName:table,Key:{pk:'ECONVENI#NATIVE_RECEIPT#'+id},ConsistentRead:true}))).Item;
 if(receipt){job.nextAt=0;await saveJob(job,'SENDING');await wakeNative();}
 else{await db.send(new PutCommand({TableName:table,Item:{...targetKey(job),jobId:id,active:false},ConditionExpression:'jobId=:id',ExpressionAttributeValues:{':id':id}}));return '外部への送信前に停止した処理です。内容を確認して操作し直してください。';}
}
async function authorized(actor:string){
 const users=new CognitoIdentityProviderClient({region:process.env.AWS_REGION||'us-west-2'}),input={UserPoolId:process.env.USER_POOL_ID||outputs.auth.user_pool_id,Username:actor};
 const [u,g]=await Promise.all([users.send(new AdminGetUserCommand(input)),users.send(new AdminListGroupsForUserCommand(input))]);
 return u.Enabled===true&&!!g.Groups?.some(x=>['Admins','ADMIN','EDITOR'].includes(x.GroupName??''));
}
async function saveJob(job:NativeJob,phase:NativeJob['phase'],reason?:string,result?:ExternalProduct){
 const terminal=phase==='COMPLETE'||phase==='ATTENTION';
 const next:NativeJob={...job,phase,state:phase==='COMPLETE'?'EC_NATIVE_DONE':phase==='ATTENTION'?'EC_NATIVE_ATTENTION':'EC_NATIVE_ACTIVE',reason,result,updatedAt:new Date().toISOString()};
 await db.send(new TransactWriteCommand({TransactItems:[
 {Put:{TableName:queueTable(),Item:next,ConditionExpression:'#p=:p',ExpressionAttributeNames:{'#p':'phase'},ExpressionAttributeValues:{':p':job.phase}}},
 ...(terminal?[{Put:{TableName:table,Item:{...targetKey(job),jobId:job.id,active:phase==='ATTENTION'},ConditionExpression:'jobId=:j',ExpressionAttributeValues:{':j':job.id}}}]:[])
 ]}));Object.assign(job,next);
}
export async function runNativeJob(job:NativeJob){
 if(job.phase==='QUEUED'){
  const account=(await db.send(new GetCommand({TableName:table,Key:{pk:'ECONVENI#ACCOUNT'},ConsistentRead:true}))).Item;
  if(account?.blockedReason)throw Error('eコンビニの接続が停止されています。設定から接続を確認してください。');
  const readyAt=Number(account?.lastSentAt??0)+30000;
  if(readyAt>Date.now())throw Object.assign(Error('WAIT_INTERVAL'),{code:'WAIT_INTERVAL',readyAt});
 }
 const lease=econveniStore(job.inventoryId),session=new EconveniHttpSession();
 await withEconveniAccount(lease,session,()=>econveniCredentialStore.credentials(),async()=>{
  const receiptKey={pk:'ECONVENI#NATIVE_RECEIPT#'+job.id};
  const receipt=(await db.send(new GetCommand({TableName:table,Key:receiptKey,ConsistentRead:true}))).Item;
  if(receipt||job.phase==='SENDING'){
   // A timeout is read-only reconciliation, NEVER a second remote command.
   const after=await session.readExternalProduct(job.productId);
   if(nativeResultMatches(job,after)){await finishNative(job,after);}
   else await saveJob(job,'ATTENTION','送信済みの結果を確定できません。eコンビニと販売先を確認してください。');
   return;
  }
  if(!await authorized(job.actor))throw Error('依頼したアカウントの編集権限が無効です。');
  const ctx=await context(job),remote=await session.readExternalProduct(job.productId);
  if((job.stockFingerprint?stockFingerprint(ctx.item)!==job.stockFingerprint:ctx.item.updatedAt!==job.inventoryVersion)||nativeFingerprint(remote,job.channel)!==job.fingerprint)throw Error('受付後に商品・数量・出品状態が変更されました。再確認してください。');
  const reason=nativeAllowed(job,remote,ctx.item,ctx.protectedSale);if(reason)throw Error(reason);
  if(job.operation==='PUBLISH')for(const id of ctx.siblingIds){const sibling=await session.readExternalProduct(id);if(sibling.channels[job.channel].state==='ACTIVE')throw Error('同じ在庫の別ページがこの販売先に出品中です。重複出品を防ぐため停止しました。');}
  const command=await session.nativePreview(job.productId,job.channel,job.operation);
  await lease.commitNative(null,{...receiptKey,inventoryId:job.inventoryId,revision:0,updatedAt:'',operation:job.operation,channel:job.channel,jobId:job.id,state:'SENDING',legacyId:ctx.legacy?.id},[
   {ConditionCheck:{TableName:inventoryTable('Inventory'),Key:{id:job.inventoryId},ConditionExpression:'updatedAt=:v',ExpressionAttributeValues:{':v':ctx.item.updatedAt}}},
   {ConditionCheck:{TableName:table,Key:targetKey(job),ConditionExpression:'jobId=:j AND active=:yes',ExpressionAttributeValues:{':j':job.id,':yes':true}}}
   ,...ctx.bindingChecks,
   ...(ctx.legacy?[{Update:{TableName:inventoryTable('ChannelListing'),Key:{id:ctx.legacy.id},UpdateExpression:'SET #s=:busy,lastError=:token,updatedAt=:now',ConditionExpression:'updatedAt=:v AND #s<>:busy',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':busy':'PUBLISHING',':token':job.id,':now':new Date().toISOString(),':v':ctx.legacy.updatedAt}}}]:[])
  ],true);
  await saveJob(job,'SENDING');
  try{await session.executeNative(command);}catch{/* Write result is unknown: reconcile below, never retry the write. */}
  const after=await session.readExternalProduct(job.productId);
  if(nativeResultMatches(job,after)){await finishNative(job,after);}
  else await saveJob(job,'ATTENTION','処理後の状態が一致しません。販売先を確認してください。');
 });
}
async function finishNative(job:NativeJob,after:ExternalProduct){
 await updateObserved(after);
 // Re-publication creates a new external ID. Keep subsequent sale/STOP routing
 // on that exact ID, including a secondary e-conveni page for this stock item.
 const [data,workflow]=await Promise.all([readManualSync(job.inventoryId),econveniStore(job.inventoryId).read()]);
 const link=data.links.find(l=>l.productId===job.productId);
 const writes=[];
 if(link&&JSON.stringify(link.baseline[job.channel])!==JSON.stringify(after.channels[job.channel]))writes.push({Put:{TableName:table,Item:{...link,pk:manualLinkKey(link),baseline:{...link.baseline,[job.channel]:after.channels[job.channel]},revision:link.revision+1},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':link.revision}}});
 if(workflow?.save.productId===job.productId&&job.channel!=='BASE'){
  const s=after.channels[job.channel],old=workflow.channels[job.channel];
  if(old.listingId!==s.listingId||old.remoteStatus!==s.state)writes.push({Put:{TableName:table,Item:{...workflow,revision:workflow.revision+1,updatedAt:new Date().toISOString(),channels:{...workflow.channels,[job.channel]:{state:'SUCCEEDED',operation:job.operation==='PUBLISH'?'PUBLISH':'STOP',remoteStatus:s.state,listingId:s.listingId,listingUrl:s.listingUrl}}},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':workflow.revision}}});
 }
 if(writes.length)await db.send(new TransactWriteCommand({TransactItems:writes}));
 const receipt=(await db.send(new GetCommand({TableName:table,Key:{pk:'ECONVENI#NATIVE_RECEIPT#'+job.id},ConsistentRead:true}))).Item;
 if(receipt?.legacyId){
  const t=inventoryTable('ChannelListing'),row=(await db.send(new GetCommand({TableName:t,Key:{id:receipt.legacyId},ConsistentRead:true}))).Item;
  // The same marker is used as the existing BASE operation lock. Reconciliation
  // may repeat after a lost response, but must never overwrite a later operation.
  if(row?.lastError===job.id){const s=after.channels[job.channel],now=new Date().toISOString();await db.send(new TransactWriteCommand({TransactItems:[{Update:{TableName:t,Key:{id:row.id},UpdateExpression:'SET #s=:s,externalListingId=:id,listingUrl=:url,lastError=:empty,updatedAt=:now',ConditionExpression:'lastError=:token AND #s=:busy',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':s':job.operation==='PUBLISH'?'ACTIVE':job.operation==='CLEAR'?'DRAFT':'PAUSED',':id':s.listingId,':url':s.listingUrl,':empty':null,':now':now,':token':job.id,':busy':'PUBLISHING'}}}]}));}
 }
 if(job.operation==='PUBLISH')await markInventoryPublished(job.inventoryId,job.actor,workerCategories);
 await saveJob(job,'COMPLETE',undefined,after);
}
async function updateObserved(product:ExternalProduct){
 const key={pk:'ECONVENI#OBSERVED_CATALOG'},r=(await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}))).Item;
 if(!r)return;
 await db.send(new PutCommand({TableName:table,Item:{...r,version:randomUUID(),products:r.products.map((p:ExternalProduct)=>p.productId===product.productId?product:p)},ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':r.version}}));
}
export async function processNativeQueue(deadline:number){
 const previous=(await db.send(new GetCommand({TableName:queueTable(),Key:{id:'EC_NATIVE_CURSOR'},ConsistentRead:true}))).Item;
 const r=await db.send(new QueryCommand({TableName:queueTable(),ExclusiveStartKey:previous?.cursor,IndexName:'ByState',KeyConditionExpression:'#s=:s',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':s':'EC_NATIVE_ACTIVE'},Limit:100}));
 let count=0;
 for(const indexed of r.Items??[]){
  if(Date.now()>deadline)break;
  const job=await getJob(indexed.id);if(!job||job.state!=='EC_NATIVE_ACTIVE'||job.nextAt>Date.now())continue;
  try{await runNativeJob(job);count++;}catch(e){
   const code=(e as {code?:string})?.code;
   if(['WAIT_INTERVAL','BUSY_OR_STOPPED'].includes(code??'')){
    job.nextAt=(e as {readyAt?:number}).readyAt||Date.now()+60000;
    await saveJob(job,job.phase);
   }else if(job.phase==='SENDING'){await saveJob(job,'ATTENTION','送信結果が未確認です。二重送信はしていません。');}
   else {await saveJob(job,'ATTENTION',safeError(e));}
  }
 }
 await db.send(new PutCommand({TableName:queueTable(),Item:{id:'EC_NATIVE_CURSOR',...(r.LastEvaluatedKey?{cursor:r.LastEvaluatedKey}:{})}}));
 return count;
}

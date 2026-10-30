'use server';
import {randomUUID,createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {uploadData} from 'aws-amplify/storage/server';
import {runWithAmplifyServerContext} from '@/lib/amplify/serverUtils';
import {canEditInventory,getInventoryRole,getCurrentInventoryUserEmail} from '@/lib/amplify/requireInventoryUser';
import {createInventory} from './inventory';
import {getInventoryRaw,persistInventoryWithCategories} from '@/lib/inventory/categoryPersistence';
import {listCategories,listLocations} from '@/lib/inventory/queries';
import {withHumanEdits} from '@/lib/inventory/humanEdits';
import {logInventoryHistory,diffField} from '@/lib/inventory/history';
import {revalidatePath} from 'next/cache';
import {restageLedger,ledgerFields,resolveRestageDefaults,restageSupplement,importCustom,type RestageLedger,type RestageDefaults} from '@/lib/procurement/restageLedger';
import {assertAuctionDate,restageInventoryFields,completeRestageDraft,type RestageLot,type RestageDraft,type RestageEdit} from '@/lib/procurement/restage';
import {claimImport,releaseImport,releaseFetchLock,getImportRecord,putImportRecord,importRecordsForDate,restageInventoryId,restageConnection,resetRestageConnection} from '@/lib/procurement/store';

async function authorize(){if(!canEditInventory(await getInventoryRole()))throw Error('定期仕入れの操作権限がありません。');}
const safeError=(e:unknown)=>e instanceof Error&&/リステージ|落札|開催|一山|写真|登録|確認|取得|商品|接続|定期仕入れ/.test(e.message)?e.message:'取得に失敗しました。再度お試しください。';
function matchesSource(row:Record<string,unknown>|undefined,lot:RestageLot){if(!row)return false;try{const fields=typeof row.customFields==='string'?JSON.parse(row.customFields):row.customFields;return fields?.__restageImport?.date===lot.date&&fields.__restageImport.goodsId===lot.goodsId;}catch{return false;}}

export async function fetchRestageAction(date:string){
  await authorize();assertAuctionDate(date);
  const lease=await claimImport('LOCK','RESTAGE',120);if(!lease)return{ok:false as const,error:'別の画面で取得中です。少し待ってからお試しください。'};
  try{
    const connection=await restageConnection(),fetched=await connection.fetchLots(date),runId=randomUUID(),who=await getCurrentInventoryUserEmail(),ttl=Math.floor(Date.now()/1000)+86400;
    const previous=await importRecordsForDate(date),registered=new Map(previous.filter(x=>x.status==='REGISTERED').map(x=>[String(x.goodsId),String(x.inventoryId)]));
    const [categories,locations]=await Promise.all([listCategories(),listLocations()]);
    const defaults=resolveRestageDefaults(categories,locations);
    // Reuse the confirmed original purchase for previously registered lots.
    // Later edits/splits to inventory must not change the auction-day ledger.
    const drafts=fetched.drafts.map(d=>{const saved=previous.find(p=>p.status==='REGISTERED'&&p.goodsId===d.goodsId)?.lot as RestageLot|undefined;return saved?{...saved,issues:[]} : d;});
    const ledger=drafts.length&&!fetched.errors.length&&drafts.every(d=>!d.issues.length)?restageLedger(drafts.map(d=>completeRestageDraft(d))):null;
    for(const lot of drafts)await putImportRecord({pk:'RUN#'+runId,sk:'LOT#'+lot.goodsId,lot,defaults,createdBy:who,createdAt:new Date().toISOString(),ttl});
    await putImportRecord({pk:'RUN#'+runId,sk:'STATE',ids:drafts.map(d=>d.goodsId),date,defaults,errors:fetched.errors,ready:false,createdBy:who,ttl});
    const lots=await Promise.all(drafts.map(async lot=>{const inventoryId=registered.get(lot.goodsId)??null,row=inventoryId?await getInventoryRaw(inventoryId):undefined;let needsUpdate=false;
      if(row&&ledger){try{needsUpdate=Object.keys(restageSupplement(row,completeRestageDraft(lot),ledger,defaults)).length>0;}catch{needsUpdate=true;}}
      return {...lot,inventoryId,needsUpdate,deleted:!!inventoryId&&!row};}));
    return {ok:true as const,runId,lots,ledger,errors:fetched.errors};
  }catch(e){resetRestageConnection();return{ok:false as const,error:safeError(e)};}
  finally{await releaseFetchLock(lease);}
}

/** Freeze one complete, server-validated auction-day plan before any stock writes. */
export async function prepareRestageRunAction(runId:string,edits:RestageEdit[]){
  await authorize();
  if(!/^[0-9a-f-]{36}$/.test(runId)||!Array.isArray(edits))return{ok:false as const,error:'取得結果が不正です。再度取得してください。'};
  try{
    const state=await getImportRecord('RUN#'+runId,'STATE'),who=await getCurrentInventoryUserEmail();
    if(!state||state.createdBy!==who||Number(state.ttl)<Date.now()/1000)throw Error('取得結果の有効期限が切れました。再度取得してください。');
    if(state.errors?.length)throw Error('商品ID・開催日などを確認できない行があります。再度取得してください。');
    const ids=state.ids as string[];
    if(!ids.length||edits.length!==ids.length||new Set(edits.map(e=>e?.goodsId)).size!==ids.length||edits.some(e=>!ids.includes(e?.goodsId)))throw Error('全商品の取得結果を確認してください。');
    const lots:RestageLot[]=[];
    for(const goodsId of ids){
      const preview=await getImportRecord('RUN#'+runId,'LOT#'+goodsId);
      if(!preview||preview.lot.date!==state.date)throw Error('取得結果が不足しています。再度取得してください。');
      const previous=await getImportRecord('DATE#'+state.date,'LOT#'+goodsId);
      const source=preview.lot as RestageDraft;
      // Successful rows are immutable on retries, including partial registrations.
      try{lots.push(previous?.status==='REGISTERED'&&previous.lot?completeRestageDraft({...previous.lot,issues:[]} as RestageDraft):completeRestageDraft(source,edits.find(e=>e.goodsId===goodsId)!));}
      catch(e){throw Error(`商品ID ${goodsId}：${(e as Error).message}`);}
    }
    const ledger=restageLedger(lots),preparedId=randomUUID(),ttl=Number(state.ttl);
    for(const lot of lots)await putImportRecord({pk:'RUN#'+preparedId,sk:'LOT#'+lot.goodsId,lot,ledger,defaults:state.defaults,createdBy:who,ttl});
    // STATE is written last: a partial snapshot can never authorize registration.
    await putImportRecord({pk:'RUN#'+preparedId,sk:'STATE',ids,date:state.date,defaults:state.defaults,errors:[],ready:true,createdBy:who,ttl});
    return {ok:true as const,runId:preparedId,ledger,lots};
  }catch(e){return{ok:false as const,error:safeError(e)};}
}

export async function registerRestageLotAction(runId:string,goodsId:string){
  await authorize();
  if(!/^[0-9a-f-]{36}$/.test(runId)||!/^\d{1,12}$/.test(goodsId))return{ok:false as const,error:'取得結果が不正です。再度取得してください。'};
  const state=await getImportRecord('RUN#'+runId,'STATE'),who=await getCurrentInventoryUserEmail();
  if(!state?.ready||state.createdBy!==who||Number(state.ttl)<Date.now()/1000||!state.ids?.includes(goodsId))return{ok:false as const,error:'取得内容を確認してから登録してください。'};
  const preview=await getImportRecord('RUN#'+runId,'LOT#'+goodsId);
  if(!preview||Number(preview.ttl)<Date.now()/1000)return{ok:false as const,error:'取得結果の有効期限が切れました。再度取得してください。'};
  const lot=preview.lot as RestageLot,ledger=preview.ledger as RestageLedger|null,defaults=preview.defaults as RestageDefaults;
  if(!ledger||ledger.date!==lot.date||ledger.version!==2||ledger.rounding!=='HALF_UP'||!defaults)return{ok:false as const,error:'全落札の台帳集計・価格計算を確認できません。再取得してください。'};
  const dayLease=await claimImport('REGISTER_DAY',lot.date);
  if(!dayLease)return{ok:false as const,error:'同じ開催日の登録処理中です。少し待って再試行してください。'};
  try{
  // Another tab may have registered a different correction since this plan was
  // prepared. Never publish a stale full-day ledger over that confirmed purchase.
  for(const record of await importRecordsForDate(lot.date)){
    if(record.status!=='REGISTERED'||!record.lot)continue;
    const planned=await getImportRecord('RUN#'+runId,'LOT#'+record.goodsId);
    const original=record.lot as RestageLot,next=planned?.lot as RestageLot|undefined;
    if(!next||['quantity','hammerPrice','isBundle','itemType'].some(k=>original[k as keyof RestageLot]!==next[k as keyof RestageLot]))return{ok:false as const,error:'別の画面で登録内容が変更されています。再取得すると登録済みの内容を引き継げます。'};
  }
  const pk='DATE#'+lot.date,sk='LOT#'+lot.goodsId,id=restageInventoryId(lot);
  const previous=await getImportRecord(pk,sk);
  if(previous?.status==='REGISTERED'){
    const inventoryId=String(previous.inventoryId),repairPk='LEDGER#'+lot.date,owner=await claimImport(repairPk,sk);
    if(!owner)return{ok:false as const,error:'この商品の台帳を更新中です。少し待って再取得してください。'};
    try{
      const existing=await getInventoryRaw(inventoryId);
      if(!existing)return{ok:true as const,id:inventoryId,skipped:true};
      const changes=restageSupplement(existing,lot,ledger,defaults);
      if(!Object.keys(changes).length)return{ok:true as const,id:inventoryId,skipped:true};
      const who=await getCurrentInventoryUserEmail(),now=new Date().toISOString();
      const custom=changes.customFields as Record<string,unknown>|undefined;
      const revision={...changes,customFields:JSON.stringify(withHumanEdits(existing,changes,importCustom(existing),custom??importCustom(existing))),updatedBy:who??'リステージ取込',listUpdatedAt:now};
      await persistInventoryWithCategories({id:inventoryId,...revision},String(existing.updatedAt));
      await logInventoryHistory(inventoryId,who,[...Object.entries(changes).filter(([key])=>key!=='customFields').map(([key,value])=>diffField('リステージ取込：'+key,existing[key]==null?null:String(existing[key]),Array.isArray(value)?value.join(' / '):String(value)))].filter((v):v is NonNullable<typeof v>=>v!==null));
      revalidatePath('/inventory');revalidatePath('/inventory/'+inventoryId);
      return{ok:true as const,id:inventoryId,skipped:true,updated:true};
    }catch(e){return{ok:false as const,error:safeError(e)};}finally{await releaseImport(repairPk,sk,owner);}
  }
  const lease=await claimImport(pk,sk);if(!lease)return{ok:false as const,error:'この商品は登録処理中です。再取得で結果を確認できます。'};
  const complete=()=>releaseImport(pk,sk,lease,{status:'REGISTERED',goodsId,inventoryId:id,lot,registeredAt:new Date().toISOString()});
  try{
    const existing=await getInventoryRaw(id);
    if(existing){if(!matchesSource(existing,lot))throw Error('登録先の商品が一致しません。確認してください。');await complete();return{ok:true as const,id,skipped:true};}
    const connection=await restageConnection(),image=await connection.image(lot);
    const ext=image.mime==='image/png'?'.png':image.mime==='image/webp'?'.webp':'.jpg',storageKey='inventory/'+id+ext;
    await runWithAmplifyServerContext({nextServerContext:{cookies},operation:context=>uploadData(context,{path:storageKey,data:image.bytes,options:{contentType:image.mime,cacheControl:'public, max-age=31536000, immutable'}}).result});
    await createInventory({...restageInventoryFields(lot),...ledgerFields(ledger),categoryId:defaults.categoryId,categoryIds:[defaults.categoryId],locationId:defaults.locationId,customFields:{...restageInventoryFields(lot).customFields,__restageImport:{date:lot.date,goodsId:lot.goodsId,hammerPrice:lot.hammerPrice,quantity:lot.quantity,multiplier:'1.188',rounding:'HALF_UP',isBundle:lot.isBundle,ledger,defaults}},images:[{kind:'uploaded',storageKey,sortOrder:0,type:'NORMAL',isPrimary:true,sourceSystem:null,sourceUrl:lot.imageUrl,thumbnailKey:null,mediumKey:null,originalHash:createHash('sha256').update(image.bytes).digest('hex'),classification:null}]},{skipRedirect:true,id});
    await complete();return{ok:true as const,id,skipped:false};
  }catch(e){
    // A response may be lost after the inventory transaction committed. Never
    // remove its image or create a different ID when retrying.
    const existing=await getInventoryRaw(id).catch(()=>undefined);
    if(matchesSource(existing,lot)){await complete();return{ok:true as const,id,skipped:false};}
    resetRestageConnection();await releaseImport(pk,sk,lease,{status:'FAILED',goodsId,lastError:safeError(e),failedAt:new Date().toISOString()});
    return{ok:false as const,error:safeError(e)};
  }
  }finally{await releaseImport('REGISTER_DAY',lot.date,dayLease);}
}

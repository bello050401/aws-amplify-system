import {randomUUID} from 'node:crypto';
import {applyFields,localFields,outgoingPatch,remoteFields,type Masters,type Row} from './mapping';
import {changedFields,equal,reconcileFields,type SharedFields} from './protocol';
import {ITEM_PREFIX,type Control} from './store';
import type {V2Inventory} from './v2Client';

export interface SyncWindow {remote:V2Inventory[];end:string;start?:string;full:boolean;initial:boolean}
export interface TransitionPort{
  getControl():Promise<Control>;
  saveControl(next:Control):Promise<Control>;
  states():Promise<Row[]>;
  saveState(next:Row):Promise<Row>;
  inventories():Promise<Row[]>;
  inventory(id:string):Promise<Row|undefined>;
  masters():Promise<Masters>;
  archive(label:string,value:unknown):Promise<string>;
  readArchive(key:string):Promise<SyncWindow>;
  saveInventory(row:Row,expected?:string):Promise<Row>;
  deleteInventory(row:Row):Promise<void>;
  generateSku():Promise<string>;
  syncImage(row:Row,remote:V2Inventory):Promise<Row>;
  history(row:Row,changes:SharedFields):Promise<void>;
  api:{
    list(input:{start?:string;end:string;page:number;includeDeleted?:boolean}):Promise<{data:V2Inventory[];pagination:{current_page:number;total_pages:number;total_count:number}}>;
    get(id:string):Promise<V2Inventory|null>;
    patch(id:string,body:Record<string,unknown>):Promise<{data?:V2Inventory}|null>;
    create(body:Record<string,unknown>):Promise<{data?:V2Inventory}|null>;
    remove(id:string):Promise<unknown>;
  };
  now():number;
  deadline:number;
}
const active=(row:Row|undefined)=>row&&!row.deletedAt&&row.listingPartition!=='MERGED';
const done=(p:TransitionPort)=>p.now()>=p.deadline-25_000;
function message(e:unknown){return e instanceof Error?e.message:'同期に失敗しました。';}

/**
 * One durable server lease surrounds this runner. Local comparisons use AWS
 * only; ZAICO requests happen solely for remote deltas or actual local edits.
 * Durable item states also detect deleted inventory pages without tombstone
 * retention in the inventory table.
 */
export async function runTransition(p:TransitionPort){
  let control=await p.getControl();
  if(control.phase==='STOPPED'||control.phase==='DISABLED')return;
  if((control.nextRunAt??0)>p.now()&&!control.work)return;
  const masters=await p.masters();
  const rows=await p.inventories();
  const states=await p.states();
  const byId=new Map(rows.map(row=>[row.id,row]));
  const bySource=new Map<string,Row>();
  for(const row of rows){
    if(!active(row)||!row.sourceInventoryId)continue;
    if(bySource.has(row.sourceInventoryId))throw Error('同一ZAICO在庫IDの重複があるため同期を停止しました。');
    bySource.set(String(row.sourceInventoryId),row);
  }
  const stateById=new Map(states.map(s=>[s.inventoryId,s]));
  const save=async(s:Row)=>{const result=await p.saveState(s);stateById.set(s.inventoryId,result);return result;};
  const statusSummary=()=>({
    rawCount:[...stateById.values()].filter(s=>s.status!=='DELETED'&&s.rawValues&&Object.keys(s.rawValues).length).length,
    issueIds:[...stateById.values()].filter(s=>(!['OK','DELETED'].includes(s.status))||(s.conflict&&!s.conflictAcknowledgedAt))
      .slice(0,100).map(s=>s.inventoryId),
  });

  async function acceptRemote(remote:V2Inventory,initial:boolean){
    const sourceId=String(remote.id);
    const linked=bySource.get(sourceId);
    let state=linked?stateById.get(linked.id):[...stateById.values()].find(s=>s.sourceId===sourceId);
    // A previous successful checkpoint must not erase a user edit on replay.
    if(initial&&state?.initialRunId===control.initialRunId&&state.status==='OK')return;
    let local=linked?await p.inventory(linked.id):state?await p.inventory(state.inventoryId):undefined;
    if(remote.deleted){
      if(local){
        if(!initial&&state&&Object.keys(changedFields(state.localBase,localFields(local))).length){
          const backup=await p.archive('conflict-deleted',local);
          state={...state,conflict:{at:new Date(p.now()).toISOString(),reason:'ZAICO側で削除。BELLOの未反映編集をバックアップしました。',backup}};
        }
        await p.archive('before-delete',{local,remote});
        await p.deleteInventory(local);
        await save({...state,id:ITEM_PREFIX+local.id,inventoryId:local.id,sourceId,status:'DELETED',remote,deletedConfirmed:true,error:null,initialRunId:control.initialRunId});
      }else if(state&&state.status!=='DELETED'){
        // A successful DELETE may lose its reply or its state write. A later
        // confirmed tombstone/404 completes the journal without deleting twice.
        await save({...state,status:'DELETED',remote,deletedConfirmed:true,error:null});
      }
      return;
    }
    const proposed=await remoteFields(remote,masters);
    if(state?.status==='WRITE_REJECTED'&&local&&equal(proposed.fields,state.remoteBase)&&equal(localFields(local),state.rejectedDesired))return;
    if(!active(local)&&state&&!initial){
      // A local deletion is a pending outbound operation, not a request to
      // recreate the page from every incoming delta. Reconcile in local pass.
      return;
    }
    if(local?.outboundBatchId)throw Error('出庫処理中のため同期を次回に延期します。');
    let changes=proposed.fields,conflicts:unknown[]=[];
    if(!initial&&local&&state?.localBase){
      const decision=reconcileFields(state.remoteBase,localFields(local),proposed.fields);
      changes=decision.toBello;conflicts=decision.conflicts;
    }
    if(!local){
      if([...stateById.values()].some(s=>s.status==='CREATE_UNCONFIRMED'&&!s.sourceId)){
        throw Error('ZAICO新規作成の結果が未確認です。重複を避けるため新しい商品の取込を保留しています。');
      }
      const id=randomUUID();
      local={id,sku:await p.generateSku(),sourceSystem:'ZAICO',sourceInventoryId:sourceId,listingPartition:'ACTIVE',images:[],createdBy:'ZAICO暫定同期'};
    }
    const before=localFields(local);
    const update=applyFields(local,changes,proposed.raw);
    if(local.sourceSystem!=='ZAICO'||String(local.sourceInventoryId)!==sourceId){
      update.sourceSystem='ZAICO';update.sourceInventoryId=sourceId;
    }
    // Image processing is only required when ZAICO's main image actually changed.
    const withImages=await p.syncImage(local,remote);
    if(!equal(local.images,withImages.images))update.images=withImages.images;
    const hasChange=!local.updatedAt||Object.keys(changedFields(before,{...before,...changes})).length||
      update.customFields!==local.customFields||update.images!==undefined||update.sourceInventoryId!==undefined;
    if(hasChange||conflicts.length)await p.archive(initial?'initial-before':'before-sync',{local,remote,conflicts});
    const saved=hasChange?await p.saveInventory({...(!local.updatedAt?local:{}),...update},local.updatedAt):local;
    if(hasChange)await p.history(saved,changedFields(before,localFields(saved)));
    byId.set(saved.id,saved);bySource.set(sourceId,saved);
    // Local-only changes stay different from the shared baseline until sent.
    const baseline=initial||!state?localFields(saved):{...state.localBase,...changes};
    for(const [key,value] of Object.entries(localFields(saved)))if(equal(value,proposed.fields[key]))baseline[key]=value;
    if(state&&state.inventoryId!==saved.id){
      await save({...state,status:'DELETED',resolvedTo:saved.id,error:null});
      state=undefined;
    }
    const nextState={...state,id:ITEM_PREFIX+saved.id,inventoryId:saved.id,sourceId,remote,
      remoteBase:proposed.fields,localBase:baseline,status:'OK',error:null,
      rawValues:proposed.raw,initialRunId:control.initialRunId,
      ...(conflicts.length?{conflict:{at:new Date(p.now()).toISOString(),fields:conflicts},conflictAcknowledgedAt:null}:{})};
    if(!equal(state,nextState))await save(nextState);
  }

  // Freeze the remote window in S3 so a Lambda timeout resumes exactly the same
  // list rather than skipping records when updated_at/page contents move.
  if(!control.work){
    const initial=control.phase==='BASELINING';
    const full=initial||control.phase==='FINALIZING'||!control.lastFullReconciliationAt||
      p.now()-Date.parse(control.lastFullReconciliationAt)>=86_400_000;
    const end=new Date(p.now()-(control.stopRequestedAt?0:5_000)).toISOString();
    const start=!full&&control.lastSuccessfulPullAt?new Date(Date.parse(control.lastSuccessfulPullAt)-60_000).toISOString():undefined;
    const remote:V2Inventory[]=[];const seen=new Set<string>();let expectedCount:number|undefined;
    for(let page=1;;page++){
      if(done(p))throw Error('差分一覧の取得時間が上限を超えました。次回に再試行します。');
      const result=await p.api.list({start,end,page,includeDeleted:true});
      if(result.pagination.current_page!==page||
        (expectedCount!==undefined&&expectedCount!==result.pagination.total_count))throw Error('ZAICO一覧が取得中に変わりました。基準日時を進めず再取得します。');
      expectedCount=result.pagination.total_count;
      for(const item of result.data){if(seen.has(String(item.id)))throw Error('ZAICO一覧のページ重複を検出。基準日時は進めません。');seen.add(String(item.id));remote.push(item);}
      if(page>=result.pagination.total_pages)break;
    }
    if(remote.length!==expectedCount)throw Error('ZAICO一覧の件数が一致しません。基準日時は進めません。');
    const backup=initial&&!control.backupKey?await p.archive('initial-full-bello',{rows,masters:{categories:masters.categories,locations:masters.locations,statuses:masters.statuses}}):control.backupKey;
    const key=await p.archive('remote-window',{remote,end,start,full,initial});
    control=await p.saveControl({...control,backupKey:backup,work:{key,index:0,end,full,initial},lastError:null});
  }
  const window=await p.readArchive(control.work.key);
  if(!Array.isArray(window.remote)||window.end!==control.work.end||typeof window.initial!=='boolean')
    throw Error('保存された同期範囲を確認できません。');
  // Reuse observed company field labels (including full-width punctuation) for
  // new items. This needs no extra ZAICO request and avoids guessing aliases.
  masters.attributeNames=[...new Set([
    ...states.flatMap(s=>Object.keys(s.remote?.optional_attributes??{})),
    ...window.remote.flatMap(r=>Object.keys(r.optional_attributes??{})),
  ])];
  const remoteIds=new Set(window.remote.map((r:V2Inventory)=>String(r.id)));
  // FULL omissions without an explicit tombstone are never assumed to be deletes.
  for(let index=control.work.index;index<window.remote.length;index++){
    if(done(p))return;
    const remote=window.remote[index] as V2Inventory;
    try{await acceptRemote(remote,window.initial);}
    catch(e){
      const linked=bySource.get(String(remote.id));
      const id=linked?.id??`remote-${remote.id}`;
      const state=stateById.get(id);
      await save({...state,id:ITEM_PREFIX+id,inventoryId:id,sourceId:String(remote.id),remote,status:'ERROR',error:message(e)});
    }
    // Item baselines make replay safe; avoid thousands of control writes.
    if((index+1)%25===0||index+1===window.remote.length)
      control=await p.saveControl({...control,work:{...control.work,index:index+1}});
  }
  if(window.full){
    const missing=new Map<string,Row>();
    for(const row of bySource.values())missing.set(String(row.sourceInventoryId),{sourceId:String(row.sourceInventoryId)});
    for(const state of stateById.values())if(state.sourceId)missing.set(state.sourceId,state);
    for(const state of missing.values()){
      if(!state.sourceId||remoteIds.has(state.sourceId)||state.status==='DELETED')continue;
      if(done(p))return;
      // Confirm absent records individually; never delete on a partial catalogue.
        const remote=await p.api.get(state.sourceId);
      if(remote)await acceptRemote(remote,window.initial);
      else await acceptRemote({id:Number(state.sourceId),deleted:true} as V2Inventory,window.initial);
    }
  }
  if(window.initial){
    const failures=[...stateById.values()].filter(s=>s.status==='ERROR');
    if(failures.length){
      control=await p.saveControl({...control,...statusSummary(),work:null,nextRunAt:p.now()+control.pollMinutes*60_000,lastError:`初回同期 ${failures.length} 件を再確認中。ZAICOへの送信は停止しています。`});
      return;
    }
    control=await p.saveControl({...control,...statusSummary(),phase:'ACTIVE',initialCompletedAt:new Date(p.now()).toISOString(),
      lastSuccessfulPullAt:window.end,lastFullReconciliationAt:window.end,work:null,nextRunAt:0,
      lastError:null,summary:{initialCount:window.remote.filter((r:V2Inventory)=>!r.deleted).length}});
    // Outbound starts on the next tick after the entire baseline completed.
    return;
  }

  // Process actual local changes, coalesced for at least 15 seconds. A no-op
  // save merely advances updatedAt and produces no ZAICO request.
  const candidates=[...new Set([...byId.keys(),...stateById.keys()])].sort();
  let pending=control.work.localPending??0;
  for(const id of candidates){
    if(control.work.localAfter&&id<=control.work.localAfter)continue;
    if(done(p))return;
    // Advance before continuing; failed/uncertain operations have durable item
    // journals and are retried on the next complete polling window.
    const checkpoint=async()=>{control=await p.saveControl({...control,work:{...control.work,localAfter:id,localPending:pending}});};
    let state=stateById.get(id);
    let local=byId.get(id);
    if(state?.status==='OK'&&active(local)&&state.localBase&&
      Object.keys(changedFields(state.localBase,localFields(local!))).length===0)continue;
    local=await p.inventory(id);
    if(!state&&!active(local))continue;
    if(local?.outboundBatchId){pending++;continue;}
    if(state?.status==='DELETED')continue;
    if(state?.status==='CREATE_UNCONFIRMED'){pending++;continue;}
    if(local?.updatedAt&&local.updatedBy!=='ZAICO暫定同期'&&p.now()-Date.parse(local.updatedAt)<15_000){pending++;continue;}
    const alive=!!active(local);
    const desired=alive?localFields(local!):{};
    if(state?.status==='WRITE_REJECTED'&&equal(desired,state.rejectedDesired)){pending++;continue;}
    const changed=state?.localBase?changedFields(state.localBase,desired):desired;
    if(alive&&state&&Object.keys(changed).length===0&&state.status==='OK')continue;
    if(!alive&&state?.deletedConfirmed)continue;
    try{
      if(!state?.sourceId){
        if(!local)continue;
        if(local.sourceInventoryId)throw Error('初回同期で未確認の商品です。ZAICOから再取得してください。');
        // Mark BEFORE non-idempotent create. A timeout must never produce a second inventory.
        state=await save({...state,id:ITEM_PREFIX+id,inventoryId:id,status:'CREATE_UNCONFIRMED',desired,localBase:desired,remoteBase:desired,localVersion:local.updatedAt});
        const response=await p.api.create(outgoingPatch(desired,undefined,masters));
        const sourceId=String(response?.data?.id??'');
        if(!/^[1-9]\d*$/.test(sourceId))throw Error('ZAICO新規作成の結果を確認できません。自動再作成は停止しました。');
        state=await save({...state,sourceId,status:'VERIFYING'});
        // Preserve concurrent edits; attaching the source identity uses the current row version.
        const latest=await p.inventory(id);
        if(!latest)throw Error('ZAICO作成中にBELLO商品が削除されました。管理者の確認が必要です。');
        local=await p.saveInventory({id,sourceSystem:'ZAICO',sourceInventoryId:sourceId},latest.updatedAt);
        bySource.set(sourceId,local);
        const verified=await p.api.get(sourceId);
        if(!verified)throw Error('作成したZAICO商品を再取得できませんでした。');
        const actual=await remoteFields(verified,masters);
        const mismatches=changedFields(desired,actual.fields);
        state=await save({...state,remote:verified,remoteBase:actual.fields,localBase:desired,
          status:Object.keys(mismatches).length?'ERROR':'OK',error:Object.keys(mismatches).length?'ZAICOで保存されなかった項目があります。':null});
        await checkpoint();
        continue;
      }
      // A real upstream read is mandatory immediately before every outbound write.
      const fresh=await p.api.get(state.sourceId);
      if(!fresh||fresh.deleted){
        await acceptRemote({id:Number(state.sourceId),deleted:true} as V2Inventory,false);
        await checkpoint();
        continue;
      }
      if(!state.localBase||!state.remoteBase){
        await acceptRemote(fresh,true);
        continue;
      }
      const current=await remoteFields(fresh,masters);
      if(!alive){
        if(!equal(state.remoteBase,current.fields)||!equal(state.remote?.item_image,fresh.item_image)||
          (state.remote?.updated_at&&fresh.updated_at&&state.remote.updated_at!==fresh.updated_at)){
          const archive=await p.archive('delete-conflict',{state,remote:fresh});
          await save({...state,status:'CONFLICT',error:'BELLO削除後にZAICOで変更されています。削除を停止しました。',conflict:{archive}});
          pending++;continue;
        }
        state=await save({...state,status:'DELETE_UNCONFIRMED'});
        await p.api.remove(state.sourceId);
        const remaining=await p.api.get(state.sourceId);
        if(remaining&&!remaining.deleted)throw Error('ZAICOの削除を確認できませんでした。');
        await save({...state,status:'DELETED',deletedConfirmed:true,error:null});
        await checkpoint();
        continue;
      }
      const decision=reconcileFields(state.remoteBase,desired,current.fields);
      if(Object.keys(decision.toBello).length||decision.conflicts.length){
        await acceptRemote(fresh,false);
        state=stateById.get(id)!;local=await p.inventory(id);
      }
      if(!local)continue;
      const toSend=decision.toZaico;
      if(Object.keys(toSend).length){
        await p.archive('before-outgoing',{local,remote:fresh,changes:toSend});
        state=await save({...state,status:'UPDATE_UNCONFIRMED',desired:{...current.fields,...toSend}});
        await p.api.patch(state.sourceId,outgoingPatch(toSend,fresh,masters));
        const verified=await p.api.get(state.sourceId);
        if(!verified)throw Error('更新後のZAICO商品を確認できませんでした。');
        const actual=await remoteFields(verified,masters);
        const refused=Object.keys(toSend).filter(key=>!equal(toSend[key],actual.fields[key]));
        if(refused.length){
          await save({...state,status:'WRITE_REJECTED',rejectedDesired:desired});
          throw Error(`ZAICOで保存を確認できない項目: ${refused.join(', ')}`);
        }
        // Store only the version actually sent. A concurrent edit remains pending.
        await save({...state,remote:verified,remoteBase:actual.fields,localBase:{...state.localBase,...decision.toBello,...toSend},status:'OK',error:null,desired:null});
      }else{
        await save({...state,remote:fresh,remoteBase:current.fields,localBase:{...state.localBase,...decision.toBello},status:'OK',error:null});
      }
    }catch(e){
      const latest=stateById.get(id)??state;
      await save({...latest,id:ITEM_PREFIX+id,inventoryId:id,status:['CREATE_UNCONFIRMED','WRITE_REJECTED'].includes(latest?.status)?latest!.status:'ERROR',error:message(e)});
      pending++;
    }
    await checkpoint();
  }
  const errors=[...stateById.values()].filter(s=>!['OK','DELETED'].includes(s.status));
  const conflicts=[...stateById.values()].filter(s=>s.conflict&&!s.conflictAcknowledgedAt);
  control=await p.saveControl({...control,...statusSummary(),work:null,lastSuccessfulPullAt:window.end,
    ...(window.full?{lastFullReconciliationAt:new Date(p.now()).toISOString()}:{}),
    nextRunAt:p.now()+control.pollMinutes*60_000,
    summary:{items:stateById.size,pending,errors:errors.length,conflicts:conflicts.length},
    lastError:errors.length?`${errors.length} 件の未反映・要確認があります。`:null});
  // Finalization is deliberately two-stage. The administrator approves a
  // verified result; ordinary ticking never stops the integration by date.
  if(control.phase==='FINALIZING'){
    control=await p.saveControl({...control,finalCheck:{at:new Date(p.now()).toISOString(),windowEnd:window.end,
      pending,errors:errors.length,conflicts:conflicts.length,allRecordsCompared:window.full}});
    if(control.stopRequestedAt&&!pending&&!errors.length&&!conflicts.length){
      // The administrator requested stopping, but that request is fulfilled only
      // after fresh remote and local checks, not a ten-minute-old UI result.
      const tail=await p.api.list({start:window.end,end:new Date(p.now()).toISOString(),page:1,includeDeleted:true});
      const latest=await p.inventories();
      const aliveRows=latest.filter(active);
      const ids=new Set(aliveRows.map(row=>row.id));
      const clean=tail.data.length===0&&tail.pagination.total_count===0&&aliveRows.every(row=>{
        const state=stateById.get(row.id);
        return state?.status==='OK'&&state.localBase&&Object.keys(changedFields(state.localBase,localFields(row))).length===0;
      })&&[...stateById.values()].every(state=>state.status==='DELETED'||ids.has(state.inventoryId));
      if(clean)await p.saveControl({...control,phase:'STOPPED',stoppedAt:new Date(p.now()).toISOString(),stoppedBy:control.stopRequestedBy,lastSuccessfulPullAt:new Date(p.now()).toISOString()});
      else await p.saveControl({...control,nextRunAt:0,lastError:'最終確認中に変更を検出しました。もう一度同期してから連携を終了します。'});
    }
  }
}

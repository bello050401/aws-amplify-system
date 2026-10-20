"use server";
import {randomUUID} from 'node:crypto';
import {ScanCommand} from '@aws-sdk/lib-dynamodb';
import {getInventoryRole,getCurrentInventoryUserEmail} from '@/lib/amplify/requireInventoryUser';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {CONTROL_ID,ITEM_PREFIX,transitionStore} from '@/lib/zaico/transition/store';
import {changedFields} from '@/lib/zaico/transition/protocol';
import {localFields,type Row} from '@/lib/zaico/transition/mapping';
import {ZAICO_SYNC_JOB_ID} from '@/lib/inventory/zaicoSyncJobId';

async function admin(){
  if(await getInventoryRole()!=='ADMIN')throw Error('管理者のみ操作できます。');
  return transitionStore(inventoryDdb,inventoryTable('ZaicoTransitionRecord'));
}
export async function getZaicoTransitionStatus(){
  const store=await admin(),control=await store.get(CONTROL_ID);
  if(!control)return {control:null,issues:[],rawCount:0};
  const items=(await Promise.all((control.issueIds??[]).slice(0,100).map((id:string)=>store.get(ITEM_PREFIX+id)))).filter(Boolean) as Row[];
  return {
    control:{phase:control.phase,pollMinutes:control.pollMinutes,companyId:control.companyId,initialCompletedAt:control.initialCompletedAt,
      lastSuccessfulPullAt:control.lastSuccessfulPullAt,lastFullReconciliationAt:control.lastFullReconciliationAt,
      lastError:control.lastError,summary:control.summary,work:control.work?{index:control.work.index,initial:control.work.initial}:null,finalCheck:control.finalCheck},
    issues:items.filter(s=>!['OK','DELETED'].includes(s.status)||(s.conflict&&!s.conflictAcknowledgedAt))
      .slice(0,100).map(s=>({id:s.inventoryId,sourceId:s.sourceId,status:s.status,error:s.error,conflict:s.conflict})),
    rawCount:control.rawCount??0,
  };
}
export async function changeZaicoTransition(input:{operation:'START'|'POLL'|'INTERVAL'|'FINAL_CHECK'|'STOP'|'ACKNOWLEDGE';minutes?:number;inventoryId?:string;confirmed?:boolean}){
  const store=await admin(),owner=randomUUID();
  if(!await store.acquire(owner))return {ok:false,message:'同期処理中です。処理が終わってからもう一度操作してください。'};
  try{
    const who=await getCurrentInventoryUserEmail();
    let control=await store.get(CONTROL_ID);
    if(input.operation==='START'){
      if(!input.confirmed)throw Error('初回はZAICOを基準にすることを確認してください。');
      if(control&&control.phase!=='DISABLED')throw Error('すでに連携設定があります。初回同期は繰り返せません。');
      const old=await transitionStore(inventoryDdb,inventoryTable('ZaicoSyncJob')).get(ZAICO_SYNC_JOB_ID);
      if(old&&['RUNNING','PENDING'].includes(old.status))throw Error('以前の同期処理が完了してから開始してください。');
      await store.put({id:CONTROL_ID,phase:'BASELINING',companyId:184402,pollMinutes:5,initialRunId:randomUUID(),startedBy:who,nextRunAt:0},control?.version);
      return {ok:true,message:'ZAICOを基準に初回同期を開始します。変更前のデータをバックアップします。'};
    }
    if(!control||control.phase==='STOPPED')throw Error('ZAICO連携は停止しています。');
    if(input.operation==='INTERVAL'){
      if(!Number.isInteger(input.minutes)||input.minutes!<1||input.minutes!>1440)throw Error('取得間隔は1〜1440分で指定してください。');
      control={...control,pollMinutes:input.minutes};
    }else if(input.operation==='POLL')control={...control,nextRunAt:0};
    else if(input.operation==='FINAL_CHECK'){
      if(control.phase!=='ACTIVE')throw Error('初回同期が完了してから操作してください。');
      control={...control,phase:'FINALIZING',work:null,nextRunAt:0,finalCheck:null};
    }else if(input.operation==='ACKNOWLEDGE'){
      if(!input.confirmed||!input.inventoryId)throw Error('競合した値を確認してください。');
      const item=await store.get(ITEM_PREFIX+input.inventoryId);
      if(!item?.conflict)throw Error('確認対象が見つかりません。');
      // This acknowledges preserved losing values, never retries an uncertain create/delete.
      await store.put({...item,conflictAcknowledgedAt:new Date().toISOString(),conflictAcknowledgedBy:who},item.version);
      return {ok:true,message:'競合内容の確認を記録しました。'};
    }else if(input.operation==='STOP'){
      const check=control.finalCheck;
      if(!input.confirmed||control.phase!=='FINALIZING'||!check?.allRecordsCompared||check.pending||check.errors||check.conflicts||
        Date.now()-Date.parse(check.at)>10*60_000)throw Error('最終照合を完了し、未同期・競合が0件になってから停止してください。');
      const states=await store.list();
      const index=new Map(states.map(s=>[s.inventoryId,s]));
      let cursor:Record<string,unknown>|undefined;
      const seen=new Set<string>();
      do{
        const page=await inventoryDdb.send(new ScanCommand({TableName:inventoryTable('Inventory'),ExclusiveStartKey:cursor,ConsistentRead:true}));
        for(const row of page.Items??[]){
          if(row.deletedAt||row.listingPartition==='MERGED')continue;
          const state=index.get(row.id);
          if(!state||state.status!=='OK'||!state.localBase||Object.keys(changedFields(state.localBase,localFields(row))).length)throw Error('最終確認後に未同期の編集があります。もう一度照合してください。');
          seen.add(row.id);
        }
        cursor=page.LastEvaluatedKey;
      }while(cursor);
      if(states.some(s=>s.status!=='DELETED'&&!seen.has(s.inventoryId)))throw Error('未反映の削除があります。もう一度照合してください。');
      control={...control,stopRequestedAt:new Date().toISOString(),stopRequestedBy:who,work:null,nextRunAt:0};
    }
    await store.put(control,control.version);
    return {ok:true,message:input.operation==='STOP'?'最後の差分と未同期の編集を再確認し、問題がなければ連携を終了します。':'設定を保存しました。'};
  }catch(e){return {ok:false,message:e instanceof Error?e.message:'設定を保存できませんでした。'};}
  finally{await store.release(owner);}
}

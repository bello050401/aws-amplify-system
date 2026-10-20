/** Temporary integration rules. No AWS or ZAICO dependency in this module. */
export type SharedFields = Record<string, string | number | boolean | null | string[]>;
export type Phase = 'DISABLED' | 'BASELINING' | 'READY' | 'ACTIVE' | 'FINALIZING' | 'STOPPED';
export interface TransitionSettings {
  phase: Phase;
  companyId: number;
  pollMinutes: number;
  initialRunId?: string;
  initialCompletedAt?: string;
  lastSuccessfulPullAt?: string;
  lastFullReconciliationAt?: string;
}
export interface FieldConflict {
  field: string;
  base: SharedFields[string] | undefined;
  bello: SharedFields[string] | undefined;
  zaico: SharedFields[string] | undefined;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? [...value].sort() : value;
export const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

/** Missing fields are not erasures. Adapters represent an explicit clear as null. */
export function changedFields(before: SharedFields, after: SharedFields): SharedFields {
  return Object.fromEntries(Object.entries(after).filter(([key,value])=>!equal(before[key],value)));
}

/** ZAICO wins a same-field collision; independent BELLO edits are still sent. */
export function reconcileFields(base: SharedFields, bello: SharedFields, zaico: SharedFields) {
  const toBello:SharedFields={}, toZaico:SharedFields={};
  const conflicts:FieldConflict[]=[];
  for(const field of new Set([...Object.keys(base),...Object.keys(bello),...Object.keys(zaico)])){
    if(!(field in zaico)) continue;
    const localChanged=field in bello && !equal(base[field],bello[field]);
    const remoteChanged=!equal(base[field],zaico[field]);
    if(equal(bello[field],zaico[field]))continue;
    if(remoteChanged){
      toBello[field]=zaico[field];
      if(localChanged)conflicts.push({field,base:base[field],bello:bello[field],zaico:zaico[field]});
    }else if(localChanged)toZaico[field]=bello[field];
  }
  return {toBello,toZaico,conflicts};
}

export interface PendingChange {
  inventoryId:string;
  revision:string;
  source:'BELLO';
  operation:'UPDATE'|'CREATE'|'DELETE';
  base:SharedFields;
  desired:SharedFields;
  dueAt:number;
  lastEventId:string;
}
/** One pending item per inventory. Worker commits with revision CAS, never blind delete. */
export function enqueueChange(input:{
  settings:TransitionSettings; existing?:PendingChange; inventoryId:string;
  eventId:string; revision:string; before:SharedFields; after:SharedFields;
  origin:'BELLO'|'ZAICO'; operation?:PendingChange['operation']; now:number;
}):PendingChange|undefined {
  const {settings,existing,before,after}=input;
  // READY changes must be retained while outbound transmission is still closed.
  if(!['ACTIVE','READY'].includes(settings.phase)||!settings.initialCompletedAt||input.origin==='ZAICO')return existing;
  if(existing?.lastEventId===input.eventId)return existing;
  const operation=input.operation??'UPDATE';
  if(operation==='UPDATE' && Object.keys(changedFields(before,after)).length===0)return existing;
  if(existing?.operation==='CREATE'&&operation==='DELETE')return undefined;
  const base=existing?.base??before;
  const desired=operation==='DELETE'?{}:{...(existing?.desired??before),...after};
  if(operation==='UPDATE'&&Object.keys(changedFields(base,desired)).length===0)return undefined;
  return {inventoryId:input.inventoryId,revision:input.revision,source:'BELLO',operation:existing?.operation==='CREATE'?'CREATE':operation,
    base,desired,dueAt:input.now+15_000,lastEventId:input.eventId};
}

export function beginInitial(settings:TransitionSettings,runId:string):TransitionSettings {
  if(!['DISABLED','READY'].includes(settings.phase))throw Error('実行中の連携は初回同期で上書きできません。');
  if(!runId)throw Error('バックアップを識別する実行番号が必要です。');
  return {...settings,phase:'BASELINING',initialRunId:runId,initialCompletedAt:undefined,lastSuccessfulPullAt:undefined};
}
export function completeInitial(settings:TransitionSettings,result:{runId:string;completedAt:string;watermark:string;failed:number;backupVerified:boolean;allPagesRead:boolean}):TransitionSettings {
  if(settings.phase!=='BASELINING'||settings.initialRunId!==result.runId)throw Error('初回同期の実行番号が一致しません。');
  if(result.failed||!result.backupVerified||!result.allPagesRead)throw Error('初回同期が完了していません。変更送信は停止中です。');
  if(!Number.isFinite(Date.parse(result.completedAt))||!Number.isFinite(Date.parse(result.watermark))||
    Date.parse(result.watermark)>Date.parse(result.completedAt))throw Error('初回同期の基準日時を確認できません。');
  return {...settings,phase:'READY',initialCompletedAt:result.completedAt,lastSuccessfulPullAt:result.watermark,lastFullReconciliationAt:result.completedAt};
}
export function activate(settings:TransitionSettings):TransitionSettings {
  if(settings.phase!=='READY'||!settings.initialCompletedAt)throw Error('ZAICO基準の初回同期が必要です。');
  return {...settings,phase:'ACTIVE'};
}
export function changePollMinutes(settings:TransitionSettings,minutes:number):TransitionSettings {
  if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('取得間隔は1〜1440分で指定してください。');
  return {...settings,pollMinutes:minutes};
}
export function finalize(settings:TransitionSettings,checks:{adminConfirmed:boolean;pending:number;conflicts:number;failed:number;allRecordsCompared:boolean;finalDeltaCompleted:boolean;writeFenceVerified:boolean}):TransitionSettings {
  if(settings.phase!=='FINALIZING'||!checks.adminConfirmed||checks.pending||checks.conflicts||checks.failed||
    !checks.allRecordsCompared||!checks.finalDeltaCompleted||!checks.writeFenceVerified)throw Error('未同期・競合・最終照合と停止中の編集を確認してから連携を終了してください。');
  return {...settings,phase:'STOPPED'};
}
export function shouldPoll(settings:TransitionSettings,now:number):boolean{
  if(!['ACTIVE','FINALIZING'].includes(settings.phase))return false;
  return !settings.lastSuccessfulPullAt||now-Date.parse(settings.lastSuccessfulPullAt)>=settings.pollMinutes*60_000;
}
export function requiresDailyCheck(settings:TransitionSettings,now:number):boolean {
  return settings.phase==='ACTIVE'&&(!settings.lastFullReconciliationAt||now-Date.parse(settings.lastFullReconciliationAt)>=86_400_000);
}

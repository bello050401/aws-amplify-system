import crypto from 'node:crypto';
import {runGit} from '../core/git.mjs';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const repairDigest=v=>crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const tuple=(code,component,operation)=>JSON.stringify([code,component,operation]);
const routes=new Map();
const route=(code,component,operations,scope)=>operations.forEach(operation=>routes.set(tuple(code,component,operation),scope));
route('SALE_AUTOMATION_FAILED','sale-automation',['identify','verify'],'sale-policy-local');
route('SALE_AUTOMATION_FAILED','sale-automation',['sell'],'sale-ledger-local');
route('SALE_AUTOMATION_FAILED','sale-automation',['adjust'],'sale-reconciliation-local');
route('SALE_LINK_FAILED','sale-automation',['identify','verify','sell','adjust'],'sale-binding-local');
route('SALE_EC_UNCONFIRMED','sale-automation',['adjust','verify'],'sale-reconciliation-local');
route('SALE_DESKTOP_FAILED','sale-desktop',['identify','verify','adjust'],'sale-desktop-state-local');
const scopeIds=new Set(routes.values());
export const protectedRepairPath=p=>typeof p!=='string'||!p||p.length>250||/[\0\r\n*?]/.test(p)||p.includes('..')||/^[\\/]|^[a-z]:/i.test(p)||/\\/.test(p)||/^(?:amplify|infra|\.github|tools)\//.test(p)||/(?:^|\/)(?:AGENTS\.md|package(?:-lock)?\.json|\.env[^/]*|middleware\.ts)$/i.test(p)||/(?:auth|credential|secret|token|mailReader)/i.test(p)||! /^(?:lib|scripts)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?)$/.test(p);
const same=(a,b)=>repairDigest(a)===repairDigest(b);
/** Fixed execution/isolation policy. Fresh bundle approval/session contents are a separate envelope. */
export function repairHostBoundary(profile){
 const s=profile.staging??{},c=profile.desktopCua??{};
 const fields=['mode','framework','service','enabled','isolatedDataConfirmed','hostname','port','dataRoot','hostAdapterPath','hostAdapterSha256','executionPolicyId','environmentId','dataScopeId','dataAdapter','qaUrl','revisionPath','operationalDataRoots','operationalPorts','operationalDataScopeIds'];
 return {profileId:profile.id,targetApp:profile.targetApp,repoPath:profile.repoPath,implementationProvider:profile.implementationProvider,models:profile.models,qaUrl:profile.qaUrl,qaSteps:profile.qaSteps,allowedDomains:profile.allowedDomains,staging:Object.fromEntries(fields.map(k=>[k,s[k]])),cua:Object.fromEntries(['directory','sessionPath','allowedActions','servedPathsSha256','postSchemaSha256','requiredFixtureOperations'].map(k=>[k,c[k]]))};
}
export function validateRepairCatalog(profile){
 const raw=profile.systemErrorRepair;
 if(!raw||raw.enabled!==true)return null;
 if(profile.id!=='inventory_web'||profile.targetApp!=='inventory_web'||profile.implementationProvider!=='codex'||profile.staging?.mode!=='local-next-isolated'||profile.staging.framework!=='nextjs'||!profile.staging.hostBundle||!profile.desktopCua)throw Error('REPAIR_HOST_PROFILE_REQUIRED');
 if(raw.schemaVersion!==1||!/^([a-f0-9]{40})$/.test(raw.release??'')||!/^[a-f0-9]{64}$/.test(raw.sourceManifestSha256??'')||!raw.scopes||typeof raw.scopes!=='object'||Array.isArray(raw.scopes)||Object.keys(raw.scopes).length<1||Object.keys(raw.scopes).length>5)throw Error('REPAIR_CATALOG_INVALID');
 const scopes={};
 for(const [id,value]of Object.entries(raw.scopes)){
  if(!scopeIds.has(id)||!value||Object.keys(value).some(k=>!['allowedPaths','verification'].includes(k)))throw Error('REPAIR_SCOPE_INVALID');
  if(!Array.isArray(value.allowedPaths)||!value.allowedPaths.length||value.allowedPaths.length>20||value.allowedPaths.some(protectedRepairPath)||new Set(value.allowedPaths.map(p=>p.toLowerCase())).size!==value.allowedPaths.length)throw Error('REPAIR_SCOPE_INVALID');
  const v=value.verification;
  if(!v||v.required!==true||Object.keys(v).some(k=>!['required','commands'].includes(k))||!Array.isArray(v.commands)||!v.commands.length||v.commands.length>12)throw Error('REPAIR_TEST_PLAN_INVALID');
  for(const c of v.commands){
   if(!c||Object.keys(c).some(k=>!['name','file','args','timeoutSeconds'].includes(k))||typeof c.name!=='string'||!c.name||c.file!=='node'||!Array.isArray(c.args)||!c.args.length||c.args.length>12||c.args.some(a=>typeof a!=='string'||!a||/[\0\r\n]/.test(a))||!Number.isInteger(c.timeoutSeconds)||c.timeoutSeconds<1||c.timeoutSeconds>600)throw Error('REPAIR_TEST_PLAN_INVALID');
   // Only the installed tsx loader is permitted; no shell/eval/absolute script.
   if(c.args.some(a=>a.startsWith('-')&&!['--import','--test','--no-warnings'].includes(a))||c.args.some((a,i)=>a==='--import'&&c.args[i+1]!=='tsx')||!c.args.some(a=>/^scripts\/[A-Za-z0-9_./-]+\.(?:cjs|mjs|ts)$/.test(a)||/^lib\/[A-Za-z0-9_./-]+\.test\.ts$/.test(a))||c.args.some(a=>!a.startsWith('-')&&a!=='tsx'&&protectedRepairPath(a)))throw Error('REPAIR_TEST_PLAN_INVALID');
  }
  scopes[id]=structuredClone(value);
 }
 const catalog={schemaVersion:1,release:raw.release,sourceManifestSha256:raw.sourceManifestSha256,scopes,hostBoundary:repairHostBoundary(profile)};
 return {...catalog,digest:repairDigest(catalog)};
}
export function resolveRepairRoute(event,profile,catalog){
 if(['SALE_AUTH_REQUIRED','SALE_RATE_LIMITED'].includes(event.code))return {status:'held',reason:'OPERATIONAL_ATTENTION'};
 if(!catalog)return {status:'held',reason:'REPAIR_HOST_PROFILE_REQUIRED'};
 if(event.surface!=='server'||!routes.has(tuple(event.code,event.component,event.operation)))return {status:'held',reason:'UNSUPPORTED_DIAGNOSTIC'};
 if(event.release!==catalog.release)return {status:'held',reason:'RELEASE_NOT_APPROVED'};
 const scopeId=routes.get(tuple(event.code,event.component,event.operation)),scope=catalog.scopes[scopeId];
 if(!scope)return {status:'held',reason:'REPAIR_SCOPE_NOT_CONFIGURED'};
 const snapshot={schemaVersion:1,profileId:'inventory_web',targetApp:'inventory_web',scopeId,release:catalog.release,sourceManifestSha256:catalog.sourceManifestSha256,routerDigest:catalog.digest,scopeDigest:repairDigest(scope),hostBoundaryDigest:repairDigest(catalog.hostBoundary),eventDigest:repairDigest(event),repoPath:profile.repoPath,allowedPaths:scope.allowedPaths,verification:scope.verification};
 const binding={...snapshot,digest:repairDigest(snapshot)};
 return {status:'ready',binding,event:structuredClone(event),contract:{profileId:'inventory_web',targetApp:'inventory_web',repoPath:profile.repoPath,allowedPaths:scope.allowedPaths,verificationRequired:true,requiresFrozenBundleReview:true,nativeCuaRequired:true,stagingMode:'local-next-isolated',implementationProvider:'codex',risk:'high'}};
}
export function readRepairRoute(repo,taskId){
 const row=repo.store.get("SELECT data FROM checkpoints WHERE task_id=? AND phase='system_error_route' ORDER BY id DESC LIMIT 1",[taskId]);
 if(!row)return null;
 const saved=JSON.parse(row.data),{digest,...snapshot}=saved.binding??{};
 if(!digest||repairDigest(snapshot)!==digest||repairDigest(saved.event)!==snapshot.eventDigest)throw Error('REPAIR_BINDING_INVALID');
 return saved;
}
/** One target-app, scope-specific closures for EVERY phase; no public profile/scope selector. */
export function withSystemErrorRouting({base,profile,repo,buildBindings}){
 let catalog,error;
 try{catalog=validateRepairCatalog(profile);}catch(e){error=e.message;}
 const cache=new Map();
 const select=event=>error?{status:'held',reason:error}:resolveRepairRoute(event,profile,catalog);
 const assertHead=release=>{const head=runGit(profile.repoPath,['rev-parse','HEAD']),status=runGit(profile.repoPath,['status','--porcelain']);if(!head.ok||head.stdout.trim()!==release||!status.ok||status.stdout.trim())throw Error('RELEASE_SOURCE_CHANGED');};
 function bound(task){
  if(!task?.idempotency_key?.startsWith('explicit:system-error:'))return base;
  const saved=readRepairRoute(repo,task.id);if(!saved)throw Error('REPAIR_BINDING_REQUIRED');
  const current=select(saved.event);if(current.status!=='ready'||!same(current.binding,saved.binding))throw Error('REPAIR_BINDING_CHANGED');
  if(task.base_commit&&task.base_commit!==saved.binding.release)throw Error('RELEASE_SOURCE_CHANGED');
  const key=saved.binding.digest;
  if(!cache.has(key)){
   const derived={...structuredClone(profile),allowedPaths:saved.binding.allowedPaths,verification:saved.binding.verification};
   delete derived.systemErrorRepair;
   cache.set(key,buildBindings(derived,profile));
  }
  return cache.get(key);
 }
 const runBinding=run=>{const task=repo.getTask(run.task_id),saved=readRepairRoute(repo,run.task_id);if(task?.idempotency_key?.startsWith('explicit:system-error:')&&run.revision!=='system-error-v2:'+saved?.binding.digest)throw Error('REPAIR_RUN_BINDING_CHANGED');return bound(task);};
 const adapters=Object.fromEntries(Object.keys(base.adapters).map(phase=>[phase,Object.fromEntries(['execute','reconcile'].map(method=>[method,context=>{const a=runBinding(context.run).adapters[phase];if(typeof a?.[method]!=='function')throw Error('REPAIR_PHASE_UNAVAILABLE');return a[method](context);}]))]));
 return {...base,adapters,
  resolveSystemErrorRepair:event=>{
   const result=select(event);if(result.status!=='ready')return result;
   try{assertHead(result.binding.release);}catch{return {status:'held',reason:'RELEASE_SOURCE_CHANGED'};}
   try{
    const caps=base.capabilities();
    if(caps.implementationProvider!=='codex'||caps.codex?.connected!==true||caps.staging?.connected!==true||caps.staging.mode!=='local-next-isolated')return {status:'held',reason:'REPAIR_HOST_PROFILE_REQUIRED'};
    return result;
   }catch{return {status:'held',reason:'REPAIR_HOST_PROFILE_REQUIRED'};}
  },
  prepareTask:(task,input)=>{const selected=bound(task);if(selected!==base){const saved=readRepairRoute(repo,task.id);assertHead(saved.binding.release);}const prepared=selected.prepareTask(task,input);if(selected!==base&&prepared.base_commit!==readRepairRoute(repo,task.id).binding.release)throw Error('RELEASE_SOURCE_CHANGED');return prepared;},
  safetyGate:async context=>{try{return await runBinding(context.run).safetyGate(context);}catch(e){return {allowed:false,reason:e.message};}},
  // Cleanup must survive revoked execution authorization. The infrastructure
  // stopTask still validates its saved task/start/PID receipt and host target.
  stopRun:run=>base.stopRun?.(run),
  stop:async()=>{await Promise.all([base,...cache.values()].map(b=>b.stop?.()));},
 };
}

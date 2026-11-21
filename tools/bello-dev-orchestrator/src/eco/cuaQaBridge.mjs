import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {validateArtifact} from './artifacts.mjs';
import {CUA_ACTIONS,CUA_CSP_SHA256} from '../pipeline/cuaBoundary.mjs';
import {inspectCuaImage} from './cuaImage.mjs';
const read=file=>{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024)throw Error('Invalid bounded CUA receipt');return JSON.parse(fs.readFileSync(file,'utf8'));};
/** Session-scoped native CUA handoff. No browser is launched by the service. */
export class CuaQaBridge{
 constructor({settings,url,verifyDeployment,evidenceRoot,now=()=>Date.now()}){Object.assign(this,{settings,url,verifyDeployment,evidenceRoot,now});fs.mkdirSync(settings.directory,{recursive:true});}
 probe(){
  try{const s=read(this.settings.sessionPath);if(s.schemaVersion!==1||s.driver!=='CUA'||s.approved!==true||typeof s.sessionId!=='string'||s.sessionId.length<8||s.sessionId.length>128||s.origin!==new URL(this.url).origin||s.bundleSha256!==this.settings.bundleSha256||s.cspSha256!==CUA_CSP_SHA256||this.settings.servedPathsSha256&&s.servedPathsSha256!==this.settings.servedPathsSha256||this.settings.postSchemaSha256&&s.postSchemaSha256!==this.settings.postSchemaSha256||!isDeepStrictEqual(s.allowedActions,this.settings.allowedActions??CUA_ACTIONS)||!Number.isFinite(s.startedAt)||!Number.isFinite(s.expiresAt)||s.startedAt>this.now()||s.expiresAt<=this.now()||s.expiresAt-s.startedAt>600000)throw Error('CUA session is expired or outside approved scope');return {ok:true,sessionId:s.sessionId,expiresAt:s.expiresAt,sessionScoped:true};}catch(e){return {ok:false,reason:e.message};}
 }
 adapter(){
  const file=(key,suffix)=>{if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid CUA operation key');return path.join(this.settings.directory,key+'.'+suffix+'.json');};
  const checked=async(run)=>{const session=this.probe();if(!session.ok)throw Error(session.reason);const deployment=await this.verifyDeployment(run);if(!deployment?.ok||!deployment.boundary||deployment.boundary.browserBoundary?.osIsolation!=='not-asserted')throw Error(deployment?.reason??'CUA deployment boundary unavailable');return {session,deployment};};
  return {
   execute:async({run,operationKey})=>{
    try{const {session,deployment}=await checked(run),target=file(operationKey,'request');if(!fs.existsSync(target))fs.writeFileSync(target,JSON.stringify({schemaVersion:1,phase:'qaVerify',runId:run.id,revision:run.revision,headSHA:run.headSHA,specId:run.specId,deploymentId:run.deployment.deploymentId,acIds:run.acIds,url:this.url,operationKey,sessionId:session.sessionId,expiresAt:session.expiresAt,token:crypto.randomBytes(32).toString('hex'),boundary:deployment.boundary},null,2),{flag:'wx',mode:0o600});return {status:'pending'};}catch(e){return {status:'blocked',reason:e.message};}
   },
   reconcile:async({run,operationKey})=>{
    const target=file(operationKey,'request');if(!fs.existsSync(target))return {status:'absent'};
    try{const {session,deployment}=await checked(run),request=read(target);if(request.specId!==run.specId||request.schemaVersion!==1||request.phase!=='qaVerify'||request.runId!==run.id||request.revision!==run.revision||request.headSHA!==run.headSHA||request.deploymentId!==run.deployment?.deploymentId||request.operationKey!==operationKey||request.sessionId!==session.sessionId||request.expiresAt<=this.now()||request.url!==this.url||!isDeepStrictEqual(request.acIds,run.acIds)||!isDeepStrictEqual(request.boundary,deployment.boundary))throw Error('CUA request/build/session changed');
     const responsePath=file(operationKey,'response');if(!fs.existsSync(responsePath))return {status:'pending'};const response=read(responsePath),equal=crypto.timingSafeEqual(crypto.createHash('sha256').update(request.token).digest(),crypto.createHash('sha256').update(String(response.token??'')).digest());
     if(!equal||response.operationKey!==operationKey||response.sessionId!==session.sessionId||!isDeepStrictEqual(response.boundary,request.boundary)||response.observed?.url!==this.url||response.observed?.navigate!==true||response.observed?.reload!==true||response.observed?.screenshot!==true)throw Error('CUA evidence authorization or observed actions mismatch');
     const root=this.evidenceRoot(run.id);validateArtifact(response.artifact,{runId:run.id,revision:run.revision,evidenceRoot:root,acIds:run.acIds});
     if(response.artifact.kind!=='qa'||response.artifact.body.specId!==request.specId||response.artifact.body.deploymentId!==request.deploymentId||response.artifact.body.url!==request.url||response.artifact.body.revision!==request.headSHA||response.artifact.body.browser?.driver!=='CUA'||response.artifact.body.browser?.osIsolation!=='not-asserted')throw Error('CUA QA artifact build/boundary mismatch');
     if(!response.artifact.evidenceRefs.length||response.artifact.evidenceRefs.length>4)throw Error('Bounded CUA screenshots required');
     const images=response.artifact.evidenceRefs.map(ref=>inspectCuaImage(root,ref));
     const fixtureActions=deployment.fixtureActions??[];if(response.artifact.body.verdict==='PASS'&&(this.settings.requiredFixtureOperations??[]).some(action=>!fixtureActions.some(row=>row.action===action&&row.success===true)))throw Error('Required synthetic fixture operations lack host-observed success');
     const identity=crypto.createHash('sha256').update(JSON.stringify({request,response,images,fixtureActions})).digest('hex'),consumed=file(operationKey,'consumed');
     if(fs.existsSync(consumed)){if(read(consumed).identity!==identity)throw Error('CUA response was already consumed');}
     else fs.writeFileSync(consumed,JSON.stringify({identity,at:this.now(),images}),{flag:'wx',mode:0o600});
     return {status:'succeeded',artifact:{...response.artifact,body:{...response.artifact.body,browser:{...response.artifact.body.browser,images,...(this.settings.requiredFixtureOperations?{fixtureActions}:{})}}},currentRevision:run.headSHA};
    }catch(e){return {status:'blocked',reason:e.message};}
   },
  };
 }
}

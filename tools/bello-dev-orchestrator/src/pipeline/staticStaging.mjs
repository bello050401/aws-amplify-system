import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {runGit} from '../core/git.mjs';
import {runProcess} from './process.mjs';

export const digest = data => crypto.createHash('sha256').update(data).digest('hex');
// Narrow smoke format: text-only HTML. No scripts, CSS, links, forms or embedded resources.
export function validateSmokeHtml(html) {
  if (Buffer.byteLength(html)>32768 || !html.includes('BELLO') || /[&]|https?:|\/\//i.test(html)) throw Error('Unsafe smoke HTML');
  const tags=html.match(/<[^>]*>/g)||[];
  for(const tag of tags) if(!/^<\/?(?:html|head|body|title|h1|p)>$|^<!doctype html>$|^<meta charset="utf-8">$/i.test(tag)) throw Error('Unsupported smoke markup');
  if(html.replace(/<[^>]*>/g,'').includes('<')) throw Error('Invalid smoke markup');
}
function zipOne(name,data) {
  const n=Buffer.from(name); let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)} crc=(crc^0xffffffff)>>>0;
  const l=Buffer.alloc(30),c=Buffer.alloc(46),e=Buffer.alloc(22);
  l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);
  e.writeUInt32LE(0x06054b50);e.writeUInt16LE(1,8);e.writeUInt16LE(1,10);e.writeUInt32LE(c.length+n.length,12);e.writeUInt32LE(l.length+n.length+data.length,16);
  return Buffer.concat([l,n,data,c,n,e]);
}
export class AmplifyStaticDelivery {
  constructor({config,repo,verifier,execute=runProcess,request=fetch}) {this.settings=structuredClone(config.staging);this.repo=repo;this.verifier=verifier;this.execute=execute;this.request=request;}
  row(id){return this.repo.store.get('SELECT * FROM staging_deliveries WHERE task_id=?',[id]);}
  update(id,state,error=null,jobId=this.row(id)?.job_id){this.repo.store.run('UPDATE staging_deliveries SET state=?,error=?,job_id=?,updated_at=? WHERE task_id=?',[state,error,jobId,new Date().toISOString(),id]);return this.row(id);}
  artifact(task){
    const s=this.settings;
    if(!s.enabled||s.mode!=='static-smoke'||!s.isolatedDataConfirmed||!/^\d{12}$/.test(s.accountId)||!/^d[a-z0-9]+$/.test(s.appId)||s.branch!=='preview-orchestrator'||s.appName!=='bello-orchestrator-smoke') throw Error('Invalid dedicated smoke target');
    if(task.isolation!=='worktree'||!task.work_dir||!this.verifier.required||!this.verifier.check(task).passed) throw Error('Independent worktree verification required');
    const head=runGit(task.work_dir,['rev-parse','HEAD']);const clean=runGit(task.work_dir,['status','--porcelain']);
    if(!head.ok||head.stdout.trim()!==task.git_end_commit||!clean.ok||clean.stdout.trim())throw Error('Verified commit must be clean');
    const artifactPath=s.artifactPath||'index.html';
    if(path.isAbsolute(artifactPath)||artifactPath.split(/[\\/]/).includes('..')||!artifactPath.endsWith('.html'))throw Error('Invalid smoke artifact path');
    if(s.sourceMode!=='bounded-main'){
      const tree=runGit(task.work_dir,['ls-tree','-r','--name-only',task.git_end_commit]);
      if(!tree.ok||tree.stdout.trim()!=='index.html')throw Error('Smoke repository must contain only index.html');
    }
    const entry=runGit(task.work_dir,['ls-tree',task.git_end_commit,artifactPath]);
    if(!entry.ok||!entry.stdout.startsWith('100644 '))throw Error('Regular committed HTML required');
    const html=fs.readFileSync(path.join(task.work_dir,artifactPath));validateSmokeHtml(html.toString('utf8'));
    return {html,sha256:digest(html),zip:zipOne('index.html',html),artifactPath};
  }
  prepare(task){
    const existing=this.row(task.id);if(existing)return existing;
    let error=null,artifact;try{artifact=this.artifact(task)}catch(e){error=e.message}
    const now=new Date().toISOString();const receipt={settings:this.settings,sha256:artifact?.sha256};
    this.repo.store.run('INSERT INTO staging_deliveries(task_id,commit_id,config_json,state,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',[task.id,task.git_end_commit,JSON.stringify(receipt),error?'blocked':'ready',error,now,now]);return this.row(task.id);
  }
  async call(operation,args=[]){
    if(!['get-app','get-branch','create-deployment','start-deployment','get-job'].includes(operation))throw Error('Unsupported operation');
    const s=this.settings;const r=await this.execute({file:'aws',args:['amplify',operation,'--app-id',s.appId,...args,'--profile',s.profile,'--region',s.region,'--output','json','--no-cli-pager'],env:{...process.env,AWS_PAGER:''},timeoutMs:30000});
    if(!r.ok)throw Error('Amplify '+operation+' failed');return JSON.parse(r.stdout);
  }
  async preflight(){
    const s=this.settings;const {app}=await this.call('get-app');const {branch}=await this.call('get-branch',['--branch-name',s.branch]);
    if(app.appArn!==`arn:aws:amplify:${s.region}:${s.accountId}:apps/${s.appId}`||app.name!==s.appName||app.platform!=='WEB'||app.repository||app.iamServiceRoleArn||app.computeRoleArn||Object.keys(app.environmentVariables||{}).length||app.buildSpec)throw Error('App is not isolated static hosting');
    if(branch.branchName!==s.branch||branch.stage!=='DEVELOPMENT'||branch.enableAutoBuild||branch.backendEnvironmentArn||branch.backend?.stackArn||branch.computeRoleArn||Object.keys(branch.environmentVariables||{}).length||branch.buildSpec)throw Error('Branch is not isolated');
  }
  async advance(task){
    const row=this.row(task.id);if(!row||['blocked','failed','succeeded'].includes(row.state))return row||{state:'blocked',error:'No receipt'};
    const saved=JSON.parse(row.config_json);
    if(JSON.stringify(saved.settings)!==JSON.stringify(this.settings))return this.update(task.id,'blocked','Target changed');
    if(row.state==='starting')return this.update(task.id,'blocked','Dispatch interrupted; inspect saved job before retry');
    let a;
    try { a=this.artifact(task); if(a.sha256!==saved.sha256)throw Error('Artifact changed'); }
    catch { return this.update(task.id,'blocked','Verified artifact or isolation changed'); }
    try{
      if(row.state==='ready'){
        await this.preflight();
        this.update(task.id,'starting');
        const deployment=await this.call('create-deployment',['--branch-name',this.settings.branch]);
        if(!/^\d+$/.test(deployment.jobId))throw Error('Invalid job');
        this.update(task.id,'starting',null,deployment.jobId);
        const url=new URL(deployment.zipUploadUrl);
        if(url.protocol!=='https:'||!url.hostname.endsWith('.amazonaws.com')||url.username||url.password)throw Error('Invalid upload host');
        const response=await this.request(url,{method:'PUT',body:a.zip,redirect:'error',signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw Error('Upload failed');
        await this.call('start-deployment',['--branch-name',this.settings.branch,'--job-id',deployment.jobId]);
        this.repo.checkpoint(task.id,'static_upload',{jobId:deployment.jobId,commit:task.git_end_commit,sha256:a.sha256,bytes:a.html.length});
        return this.update(task.id,'running',null,deployment.jobId);
      }
      const {job}=await this.call('get-job',['--branch-name',this.settings.branch,'--job-id',row.job_id]);
      if(job.summary.jobId!==row.job_id)throw Error('Job mismatch');
      if(['FAILED','CANCELLED'].includes(job.summary.status))return this.update(task.id,'failed','Amplify '+job.summary.status);
      if(job.summary.status==='SUCCEED'){
        const url=`https://${this.settings.branch}.${this.settings.appId}.amplifyapp.com/index.html?verified=${a.sha256}`;
        const response=await this.request(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw Error('HTTP not ready');
        const reader=response.body.getReader();const chunks=[];let size=0;
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();throw Error('HTTP body too large')}chunks.push(value)}
        if(digest(Buffer.concat(chunks))!==a.sha256)throw Error('Published content mismatch');
        this.repo.checkpoint(task.id,'static_http',{url,status:response.status,sha256:a.sha256,commit:task.git_end_commit,jobId:row.job_id});
        return this.update(task.id,'succeeded');
      }
      if(Date.now()-Date.parse(row.created_at)>(this.settings.maxWaitSeconds||600)*1000)throw Error('Deadline exceeded');
      return row;
    }catch(e){
      const current=this.row(task.id);
      // Network errors can contain signed URLs. Store no raw transport exception.
      if(current.state==='running'&&Date.now()-Date.parse(row.created_at)<(this.settings.maxWaitSeconds||600)*1000)return this.update(task.id,'running','Waiting for verified publication');
      return this.update(task.id,'blocked',current.state==='starting'?'Dispatch uncertain; inspect saved job':'Static verification failed');
    }
  }
}

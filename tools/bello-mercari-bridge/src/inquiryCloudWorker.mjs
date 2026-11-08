import {open,readFile,unlink,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openBelloAdminContext,validBelloOrigin} from './belloSession.mjs';
import {openInquiryReadSession} from './session.mjs';
import {readExactInquiry} from './inquiryReader.mjs';
import {loadInquiryConfig} from './inquiryConfig.mjs';

const FAILURES=new Set(['AUTH_REQUIRED','PAGE_CHANGED','TIME_LIMIT','ACTION_LIMIT','INCOMPLETE_HISTORY']);
const REQUEST_FAILURES=new Set(['ORIGIN_MISMATCH','CONTENT_TYPE_INVALID','NEXT_ACTION_FORBIDDEN','READ_HEADER_REQUIRED']);
const wait=(ms,signal)=>new Promise(resolve=>{
  if(signal?.aborted)return resolve();
  const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
  const timer=setTimeout(finish,ms);signal?.addEventListener('abort',finish,{once:true});
});
export async function runInquiryReadWorker(config,{once=false,onStatus=()=>{},signal}={},ports={}){
  if(!validBelloOrigin(config.origin)||!config.root||!config.shopId)throw Error('INVALID_CONFIG');
  const root=resolve(config.root);await mkdir(root,{recursive:true});
  const lockPath=join(root,'inquiry-worker.lock');
  try{const saved=JSON.parse(await readFile(lockPath,'utf8'));try{process.kill(saved.pid,0);throw Error('ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}await unlink(lockPath);}catch(e){if(e.code!=='ENOENT')throw e;}
  const lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));
  let bello,shops;
  const status=async(code)=>{
    // A single overwritten status file contains no conversation, credential, or message body.
    const target=join(root,'reader-status.json'),temp=target+'.'+process.pid+'.tmp';
    await writeFile(temp,JSON.stringify({schemaVersion:1,code,at:new Date().toISOString(),pid:process.pid}),{mode:0o600});
    await rename(temp,target);onStatus(code);
  };
  try{
    bello=await (ports.openBello??openBelloAdminContext)({origin:config.origin,profileDir:resolve(config.belloProfileDir),playwrightModulePath:resolve(config.playwrightModulePath)});
    shops=await (ports.openShops??openInquiryReadSession)({root,shopId:config.shopId,profileDir:resolve(config.profileDir),playwrightModulePath:resolve(config.playwrightModulePath)});
    const call=async(data)=>{
      let response;
      try{response=await bello.request.post(config.origin+'/api/inventory/inquiry-read',{headers:{Origin:config.origin,'Content-Type':'application/json','x-bello-inquiry-read':'1'},data:JSON.stringify(data),maxRedirects:0,timeout:20000});}
      catch{throw Error('CONNECTION_RETRY');}
      if(response.status()===401||response.status()===403){
        const denied=await response.json().catch(()=>({}));
        throw Error(REQUEST_FAILURES.has(denied.code)?denied.code:'BELLO_AUTH_REQUIRED');
      }
      if(response.status()===429||response.status()>=500)throw Error('CONNECTION_RETRY');
      if(!response.ok())throw Error('RESULT_NOT_ACCEPTED');
      const result=await response.json();if(result.ok!==true)throw Error('RESULT_NOT_ACCEPTED');return result;
    };
    let failures=0;
    do{
      if(signal?.aborted)break;
      try{
      const {job,serverTime}=await call({action:'CLAIM'});
      if(!job){failures=0;await status('WAITING');if(once)break;await (ports.wait??wait)(15000,signal);continue;}
      if(job.shopId!==config.shopId||!/^READ#[a-f0-9]{64}$/.test(job.jobId))throw Error('ACCOUNT_MISMATCH');
      // Windows clock drift must not make a freshly captured page look stale.
      // Use authenticated BELLO server time plus monotonic elapsed time; keep
      // the server freshness and lease checks unchanged.
      if(!Number.isSafeInteger(serverTime)||serverTime<=0)throw Error('CLOCK_SYNC_REQUIRED');
      const monotonicNow=ports.monotonicNow??(()=>performance.now());
      const receivedAt=monotonicNow();
      const captureNow=()=>serverTime+Math.max(0,monotonicNow()-receivedAt);
      let snapshot;
      try{snapshot=await (ports.read??readExactInquiry)(shops.page,job,{now:captureNow});}
      catch(e){const reason=FAILURES.has(e.message)?e.message:'READ_FAILED';await call({action:'FAIL',jobId:job.jobId,leaseId:job.leaseId,reason});await status(reason);if(reason==='AUTH_REQUIRED'||once)break;continue;}
      const report={action:'COMPLETE',jobId:job.jobId,leaseId:job.leaseId,snapshot};
      // Retry only the idempotent receipt. Never repeat a provider action after a lost response.
      try{await call(report);}catch(e){if(e.message!=='CONNECTION_RETRY')throw e;await call(report);}
      snapshot=null;failures=0;await status('COMPLETED');
      }catch(e){
        if(e.message!=='CONNECTION_RETRY'||once)throw e;
        await status('CONNECTION_RETRY');
        // A lost CLAIM/COMPLETE response leaves its lease in AWS. The next claim
        // respects that lease; the provider page is never blindly read again.
        await (ports.wait??wait)(Math.min(60000,15000*2**Math.min(failures++,2)),signal);
      }
    }while(!once);
  }catch(e){await status(['BELLO_AUTH_REQUIRED','ACCOUNT_MISMATCH','CONNECTION_RETRY','RESULT_NOT_ACCEPTED','CLOCK_SYNC_REQUIRED'].includes(e.message)||REQUEST_FAILURES.has(e.message)?e.message:'STOPPED_ERROR');throw e;
  }finally{
    await shops?.context.close().catch(()=>{});await bello?.close().catch(()=>{});
    await lock.close();await unlink(lockPath).catch(()=>{});
  }
}

if(process.argv[1]?.endsWith('inquiryCloudWorker.mjs')){
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  try{const config=await loadInquiryConfig(process.argv[2]);await runInquiryReadWorker(config,{once:process.argv.includes('--once'),signal:controller.signal,onStatus:code=>process.stdout.write(code+'\n')});}
  catch(e){process.stderr.write(['ALREADY_RUNNING','BELLO_AUTH_REQUIRED','ACCOUNT_MISMATCH'].includes(e.message)?e.message+'\n':'確認用ブラウザを起動できませんでした。設定・ログインを確認してください。\n');process.exitCode=1;}
}

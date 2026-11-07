import {open,readFile,unlink,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openBelloAdminContext,validBelloOrigin} from './belloSession.mjs';
import {openInquiryReadSession} from './session.mjs';
import {readExactInquiry} from './inquiryReader.mjs';

const FAILURES=new Set(['AUTH_REQUIRED','PAGE_CHANGED','TIME_LIMIT','ACTION_LIMIT','INCOMPLETE_HISTORY']);
export async function runInquiryReadWorker(config,{once=false,onStatus=()=>{},signal}={}){
  if(!validBelloOrigin(config.origin)||!config.root||!config.shopId)throw Error('INVALID_CONFIG');
  const root=resolve(config.root);await mkdir(root,{recursive:true});
  const lockPath=join(root,'inquiry-worker.lock');
  try{const saved=JSON.parse(await readFile(lockPath,'utf8'));try{process.kill(saved.pid,0);throw Error('ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}await unlink(lockPath);}catch(e){if(e.code!=='ENOENT')throw e;}
  const lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));
  let bello,shops;
  try{
    bello=await openBelloAdminContext({origin:config.origin,profileDir:resolve(config.belloProfileDir),playwrightModulePath:resolve(config.playwrightModulePath)});
    shops=await openInquiryReadSession({root,shopId:config.shopId,profileDir:resolve(config.profileDir),playwrightModulePath:resolve(config.playwrightModulePath)});
    const call=async(data)=>{
      const response=await bello.request.post(config.origin+'/api/inventory/inquiry-read',{headers:{Origin:config.origin,'Content-Type':'application/json','x-bello-inquiry-read':'1'},data:JSON.stringify(data),maxRedirects:0,timeout:20000});
      if(response.status()===401||response.status()===403)throw Error('BELLO_AUTH_REQUIRED');
      if(!response.ok())throw Error('RESULT_NOT_ACCEPTED');
      const result=await response.json();if(result.ok!==true)throw Error('RESULT_NOT_ACCEPTED');return result;
    };
    do{
      if(signal?.aborted)break;
      const {job}=await call({action:'CLAIM'});
      if(!job){onStatus('待機中');if(once)break;await new Promise(r=>setTimeout(r,15000));continue;}
      if(job.shopId!==config.shopId||!/^READ#[a-f0-9]{64}$/.test(job.jobId))throw Error('ACCOUNT_MISMATCH');
      let snapshot;
      try{snapshot=await readExactInquiry(shops.page,job);}
      catch(e){const reason=FAILURES.has(e.message)?e.message:'READ_FAILED';await call({action:'FAIL',jobId:job.jobId,leaseId:job.leaseId,reason});onStatus(reason);if(reason==='AUTH_REQUIRED')break;continue;}
      const report={action:'COMPLETE',jobId:job.jobId,leaseId:job.leaseId,snapshot};
      // Retry only the idempotent receipt. Never repeat a provider action after a lost response.
      try{await call(report);}catch{await call(report);}
      snapshot=null;onStatus('問い合わせ本文を取得しました');
    }while(!once);
  }finally{
    await shops?.context.close().catch(()=>{});await bello?.close().catch(()=>{});
    await lock.close();await unlink(lockPath).catch(()=>{});
  }
}

if(process.argv[1]?.endsWith('inquiryCloudWorker.mjs')){
  try{const config=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));await runInquiryReadWorker(config,{once:process.argv.includes('--once'),onStatus:code=>process.stdout.write(code+'\n')});}
  catch(e){process.stderr.write(['ALREADY_RUNNING','BELLO_AUTH_REQUIRED','ACCOUNT_MISMATCH'].includes(e.message)?e.message+'\n':'確認用ブラウザを起動できませんでした。設定・ログインを確認してください。\n');process.exitCode=1;}
}

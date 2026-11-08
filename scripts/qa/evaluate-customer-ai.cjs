const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const{LambdaClient,GetFunctionConfigurationCommand}=require('@aws-sdk/client-lambda');
const dir=path.resolve('artifacts/customer-ai-20261108'),old='artifacts/whole-instruction-20261107/mercari-history-private';
const runName=process.env.BELLO_AI_EVAL_RUN||'baseline';
assert(/^[a-z0-9-]{1,40}$/.test(runName));
const stem=runName==='baseline'?'evaluation':'evaluation-'+runName;
(async()=>{
 const {Environment}=await new LambdaClient({region:'us-west-2'}).send(new GetFunctionConfigurationCommand({FunctionName:'amplify-d4hkkg7dty2du-claudeinvento-Worker11F36D0F-2WWHmekQi8Jm'}));Object.assign(process.env,Environment.Variables);assert.equal(process.env.INQUIRY_CUSTOMER_DELIVERY_ENABLED,'false');
 const aliases={'server-only':'amplify/functions/inquiry-runtime/server-only.ts','@/lib/amplify/dataClient':'amplify/functions/inquiry-runtime/dataClient.ts','@/lib/inquiry/runtime/config':'amplify/functions/inquiry-runtime/config.ts','@/lib/inventory/mutationSession':'amplify/functions/inquiry-runtime/webBoundary.ts','@/lib/amplify/serverUtils':'amplify/functions/inquiry-runtime/webBoundary.ts'};
 await require('esbuild').build({stdin:{contents:`import {generateInquiryReplyDraft} from './lib/inquiry/pipeline';import {runWithDirectData} from './lib/amplify/dataClient';export {redactInquiryRecord} from './lib/messaging/contactPrivacy';export {readBudgetSummary} from './lib/ai/gateway/commonBudget';export const run=(request:any)=>runWithDirectData(()=>generateInquiryReplyDraft(request));`,loader:'ts',resolveDir:process.cwd()},outfile:path.join(dir,'evaluation-runner.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',packages:'external',alias:Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,path.resolve(v)]))});
 const {run,redactInquiryRecord,readBudgetSummary}=require(path.join(dir,'evaluation-runner.cjs'));
 const held=JSON.parse(fs.readFileSync(old+'/heldout-results-v2-private.json')).filter(r=>r.input);
 const cases=held.map(r=>({split:'heldout',source:r.id,input:{...r.input,historySourceId:r.id}}));
 const analysis=JSON.parse(fs.readFileSync(old+'/analysis-private.json'));
 // Development examples remain separate from the frozen held-out set. No staff reply is provided.
 for(const r of analysis){if(cases.length>=100)break;const first=r.messages.findIndex(m=>m.speaker==='BUYER');if(first<0)continue;const q=[];for(let i=first;i<r.messages.length&&r.messages[i].speaker==='BUYER';i++)q.push(r.messages[i].body);if(!q.join('').trim())continue;
 cases.push({split:'development',source:r.sourceId,input:{channel:'MERCARI_SHOPS',conversationId:'evaluation-'+r.sourceId,messageId:'evaluation-first',historySourceId:r.sourceId,messageText:q.join('\n'),history:[],customerSentAttachment:false,productLookupText:r.productId?'https://mercari-shops.com/products/'+r.productId:null}});}
 assert.equal(cases.length,100);assert.equal(new Set(cases.map(c=>c.source)).size,100);
 const file=path.join(dir,stem+'-private.json');const results=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];
 const beforeFile=path.join(dir,stem+'-budget-before.json');
 const before=fs.existsSync(beforeFile)?JSON.parse(fs.readFileSync(beforeFile)):await readBudgetSummary();
 if(!fs.existsSync(beforeFile))fs.writeFileSync(beforeFile,JSON.stringify(before));
 for(const c of cases){const caseId=crypto.createHash('sha256').update(c.source).digest('hex').slice(0,12);if(results.some(r=>r.caseId===caseId))continue;
 const input=redactInquiryRecord(c.input);const started=Date.now();let result,error=null;
 const original={log:console.log,warn:console.warn,error:console.error};console.log=console.warn=console.error=()=>{};
 try{result=await run(input);}catch(e){error=e.name;}finally{Object.assign(console,original);}
 const safe=redactInquiryRecord(result??null);
 results.push({caseId,split:c.split,question:input.messageText,elapsedMs:Date.now()-started,error,result:safe,reviewer:null,acceptedWithoutEdit:null,expectedTarget:null,expectedFacts:null,criticalErrors:null});
 fs.writeFileSync(file,JSON.stringify(results,null,2));console.log(JSON.stringify({processed:results.length,total:100,status:result?.status??'ERROR',elapsedMs:Date.now()-started}));
 }
 const after=await readBudgetSummary();const times=results.map(r=>r.elapsedMs).sort((a,b)=>a-b);const states={};for(const r of results){const k=r.error??r.result?.status??'UNKNOWN';states[k]=(states[k]||0)+1;}
 const summary={at:new Date().toISOString(),runName,cases:results.length,split:{heldout:results.filter(r=>r.split==='heldout').length,development:results.filter(r=>r.split==='development').length},humanReviewed:0,acceptance:'NOT_SCORED',states,p50Ms:times[49],p95Ms:times[94],maxMs:times.at(-1),budgetBefore:before,budgetAfter:after,customerMessagesSent:0,createdReplyDrafts:0,notes:['実環境の現在の在庫を参照した再生。過去時点の正解を再現していません。','後続のスタッフ返信を入力から除外。同じ会話の返信例も検索対象から除外。','担当者採点前。生成成功率は品質合格率ではありません。','月上限はbudgetAfter.capJPYに記録。従来評価を上書きしません。']};
 fs.writeFileSync(path.join(dir,stem+'-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1});

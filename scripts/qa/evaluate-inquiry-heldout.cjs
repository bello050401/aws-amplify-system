// Frozen held-out conversations: current inventory read + draft generation only.
// No ReplyDraft/Conversation writes and no notification/customer transport imports.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {LambdaClient,GetFunctionConfigurationCommand}=require('@aws-sdk/client-lambda');
const out=path.resolve('artifacts/whole-instruction-20261107'),dir=path.join(out,'mercari-history-private');
(async()=>{
 const lambda=new LambdaClient({region:'us-west-2'});
 const {Environment}=await lambda.send(new GetFunctionConfigurationCommand({FunctionName:'amplify-d4hkkg7dty2du-claudeinvento-Worker11F36D0F-2WWHmekQi8Jm'}));
 Object.assign(process.env,Environment.Variables);
 assert.equal(process.env.INQUIRY_CUSTOMER_DELIVERY_ENABLED,'false');
 assert(process.env.AI_BUDGET_CONFIG_JSON,'Use the deployed monthly cost cap');
 await require('esbuild').build({stdin:{contents:'import {generateInquiryReplyDraft} from "./lib/inquiry/pipeline"; import {runWithDirectData} from "./lib/amplify/dataClient"; export const run=(request:any)=>runWithDirectData(()=>generateInquiryReplyDraft(request));',loader:'ts',resolveDir:process.cwd()},outfile:path.join(out,'heldout-runner.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',packages:'external',alias:{'server-only':path.resolve('amplify/functions/inquiry-runtime/server-only.ts'),'@/lib/amplify/dataClient':path.resolve('amplify/functions/inquiry-runtime/dataClient.ts'),'@/lib/inquiry/runtime/config':path.resolve('amplify/functions/inquiry-runtime/config.ts'),'@/lib/inventory/mutationSession':path.resolve('amplify/functions/inquiry-runtime/webBoundary.ts'),'@/lib/amplify/serverUtils':path.resolve('amplify/functions/inquiry-runtime/webBoundary.ts')}});
 const {run}=require(path.join(out,'heldout-runner.cjs'));
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'heldout-manifest-private.json'),'utf8'));
 const analysis=new Set(JSON.parse(fs.readFileSync(path.join(dir,'analysis-private.json'),'utf8')).map(r=>r.sourceId));
 const resultPath=path.join(dir,'heldout-results-v2-private.json');
 const results=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):[];
 for(const entry of manifest.cases){
  assert(!analysis.has(entry.id));if(results.some(r=>r.id===entry.id))continue;
  const raw=fs.readFileSync(path.join(dir,entry.id+'.txt'),'utf8');
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),entry.sha256);
  const section=raw.split('- heading "メッセージ内容" [level=2]')[1]?.split('- textbox')[0]?.split('- heading "メッセージ概要"')[0]||'';
  const matches=[...section.matchAll(/^- paragraph: (.*)$/gm)],ps=matches.map(m=>m[1].trim()),messages=[];
  for(let i=2;i<ps.length;i++)if(/^\d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}$/.test(ps[i]))messages.push({speaker:ps[i-2]==='オーナー'||section.slice(matches[i].index+matches[i][0].length,matches[i+1]?.index??section.length).includes('img "Seller Avatar"')?'STAFF':'BUYER',body:ps[i-1],sentAt:ps[i]});
  assert(messages.length,'Transcript is incomplete');
  const first=messages.findIndex(m=>m.speaker==='BUYER');
  if(first<0){results.push({id:entry.id,sha256:entry.sha256,generatedAt:new Date().toISOString(),elapsedMs:0,result:null,error:'NO_CUSTOMER_QUESTION',reviewer:null});fs.writeFileSync(resultPath,JSON.stringify(results,null,2));console.log(JSON.stringify({processed:results.length,total:manifest.cases.length,status:'NO_CUSTOMER_QUESTION'}));continue;}
  const questions=[];for(let i=first;i<messages.length&&messages[i].speaker==='BUYER';i++)questions.push(messages[i].body);
  // Freeze the first customer turn; later staff answers never enter generation.
  const productId=raw.match(/\/products\/([A-Za-z0-9_-]+)/)?.[1]??null;
  const productTitle=raw.split('- heading "メッセージ概要"')[1]?.match(/  - img "([^\n]+)"/)?.[1]??null;
  const orderId=raw.match(/- link "(order_[A-Za-z0-9_-]+)"/)?.[1]??null;
  const request={channel:'MERCARI_SHOPS',conversationId:'heldout-'+entry.id,messageId:'heldout-first-'+entry.id,messageText:questions.join('\n'),history:[],customerSentAttachment:false,productLookupText:productId?'https://mercari-shops.com/products/'+productId:null,productTitle,additionalContext:orderId?'購入済み注文についての問い合わせです。注文番号・商品名は管理画面で確認済みです。':null,order:orderId?{orderId,productName:productTitle,itemAmountYen:null,shippingFeeYen:null,couponDiscountYen:null,totalAmountYen:null}:null};
  const started=Date.now();let result,error=null;
  const original={log:console.log,warn:console.warn,error:console.error};console.log=console.warn=console.error=()=>{};
  try{result=await run(request);}catch(e){error=e.name;}finally{Object.assign(console,original);}
  results.push({id:entry.id,sha256:entry.sha256,generatedAt:new Date().toISOString(),elapsedMs:Date.now()-started,input:request,result:result??null,error,reviewer:null,correctInventoryId:null,identifiable:null,replyAcceptedWithoutFactEdit:null,criticalErrors:null});
  fs.writeFileSync(resultPath,JSON.stringify(results,null,2));
  console.log(JSON.stringify({processed:results.length,total:manifest.cases.length,status:result?.status??'ERROR',elapsedMs:Date.now()-started}));
 }
 const times=results.filter(r=>!r.error).map(r=>r.elapsedMs).sort((a,b)=>a-b);
 const summary={at:new Date().toISOString(),cases:results.length,evaluable:results.filter(r=>r.input).length,excludedNoCustomerQuestion:results.filter(r=>r.error==='NO_CUSTOMER_QUESTION').length,execution:'current source bundle / real AWS inventory and bounded AI / no customer send',customerMessagesSent:0,staffNotificationsSent:0,storedReplyDrafts:0,states:results.reduce((a,r)=>{const state=r.error==='NO_CUSTOMER_QUESTION'?'EXCLUDED_NO_CUSTOMER_QUESTION':r.error?'ERROR':r.result?.status??'UNKNOWN';a[state]=(a[state]||0)+1;return a;},{}),p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1],humanReviewed:0,qualityAcceptance:'未採点。現在の在庫を使用した再生で、過去時点の在庫の再現ではありません。初回顧客発言のみを採用し、その後の社員回答は生成に渡していません。'};
 fs.writeFileSync(path.join(out,'heldout-generation-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});

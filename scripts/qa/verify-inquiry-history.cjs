const assert=require('node:assert/strict'),vm=require('node:vm'),esbuild=require('esbuild');
(async()=>{
 const load=async(file)=>{const b=await esbuild.build({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false});const s={module:{exports:{}},exports:{},require,URL,console};vm.runInNewContext(b.outputFiles[0].text,s);return s.module.exports;};
 const h=await load('lib/inquiry/replyHistory.ts'),rules=await load('lib/inquiry/replyRuleSelection.ts');
 let passed=0;function check(label,fn){fn();passed++;console.log('PASS '+label);}
 const make=(over={})=>h.buildHistoricalReplies({conversationId:'c1',sourceId:'s1',channel:'LINE',messages:[
 {id:'q',body:'お値下げと領収書をお願いします。',direction:'INBOUND',sentAt:'2026-10-01T10:00:00+09:00',verifiedStaff:false},
 {id:'a',body:'お問い合わせありがとうございます。領収書はメールでお送りできます。銀行振込の場合、12,500円でご案内します。',direction:'OUTBOUND',sentAt:'2026-10-01T10:01:00+09:00',verifiedStaff:true,...over}]});
 const row=make()[0];
 check('sent staff response is indexed with source and normalized date',()=>{assert(row);assert.equal(row.sentAt,'2026-10-01T01:01:00.000Z');assert.equal(row.sourceHash.length,64);assert(row.topics.includes('RECEIPT'));});
 check('draft/AI/unsent answer is excluded',()=>assert.equal(make({verifiedStaff:false}).length,0));
 check('idempotent stable identity',()=>assert.equal(make()[0].id,row.id));
 check('customer body and old price absent',()=>{assert(!row.question.includes('お願いします'));assert(!row.reply.includes('12,500'));});
 check('sensitive sentences and signatures are omitted',()=>{const s=h.sanitizeHistoricalReply('田中様、承知しました。住所は東京都国立市1-2です。連絡先 abc@example.jp 電話090-1234-5678。請求書をPDFにてお送りします。━━━━取締役 私の名前');assert.equal(s,'請求書をPDFにてお送りします。');});
 check('generic invoice account guidance is retained',()=>assert(h.sanitizeHistoricalReply('請求書に記載の口座へお振り込みください。').includes('記載の口座')));
 check('known source URL only; strip tracking',()=>{assert.equal(h.safeHistoryUrl('https://evil.example/chat'),null);assert.equal(h.safeHistoryUrl('https://chat.line.biz/U'+'a'.repeat(32)+'/chat/U'+'b'.repeat(32)+'?secret=1'),'https://chat.line.biz/U'+'a'.repeat(32)+'/chat/U'+'b'.repeat(32));});
 check('same case and remote identity excluded',()=>{assert.equal(h.selectHistoricalReplies([row],{text:'領収書',channel:'LINE',conversationId:'c1'}).length,0);assert.equal(h.selectHistoricalReplies([row],{text:'領収書',channel:'LINE',conversationId:'other',excludeSourceIds:['s1']}).length,0);});
 check('future and duplicate examples excluded',()=>{assert.equal(h.selectHistoricalReplies([row],{text:'領収書',channel:'LINE',conversationId:'other',before:'2026-09-01'}).length,0);assert.equal(h.selectHistoricalReplies([row,row],{text:'領収書',channel:'LINE',conversationId:'other'}).length,1);});
 check('another sales channel cannot supply payment or receipt instructions',()=>assert.equal(h.selectHistoricalReplies([{...row,channel:'MERCARI_SHOPS'}],{text:'領収書',channel:'LINE',conversationId:'other'}).length,0));
 check('multiple questions retain topic coverage',()=>{const rows=[row,{...row,id:'payment',sourceId:'s2',topics:['PAYMENT']},{...row,id:'delivery',sourceId:'s3',topics:['DELIVERY']}];const found=h.selectHistoricalReplies(rows,{text:'領収書。銀行振込です。配送先は東京都です。',channel:'LINE',conversationId:'other'});assert.equal(found.length,3);});
 check('receipt rule survives short follow-up',()=>{const base={id:'receipt',category:'RECEIPT',enabled:true,channelScope:[],productCategoryScope:[],priority:1,title:'領収書'};assert.equal(rules.selectReplyRules({rules:[base],intents:['NEGOTIATION'],channel:'LINE',productCategoryId:null,inquiryText:'領収書をお願いできますか。銀行振込です。'}).length,1);assert.equal(rules.selectReplyRules({rules:[{...base,channelScope:['MERCARI_SHOPS']}],intents:['OTHER'],channel:'LINE',productCategoryId:null,inquiryText:'領収書'}).length,0);});
 check('product claims never enter historical model wording',()=>{const s=h.historicalWording('お問い合わせありがとうございます。状態はどれも同等程度であることを確認しております。請求書はこのLINEでお送りします。');assert(!s.includes('同等'));assert(s.includes('請求書'));});
 const d=await load('lib/inquiry/discount.ts');
 check('BASE price multiplied by 0.95 using yen-safe arithmetic',()=>{assert.equal(d.calculateBaseDiscountedPrice(61800),58710);assert.equal(d.calculateBaseDiscountedPrice(29800),28310);assert.equal(d.calculateBaseDiscountedPrice(999),949);});
 const ap=await load('lib/inquiry/answerPlan.ts');
 check('counteroffer is recognized without the word discount',()=>{const result=ap.inspectAnswerPlanCoverage('58,710円でご案内できます。',{items:[{questionId:'Q1',topic:'NEGOTIATION',status:'ANSWERABLE',evidenceRefs:[],answerConstraints:[]}]});assert.equal(result.hasLikelyGap,false);});
 check('missing unknown answer is still flagged',()=>{const result=ap.inspectAnswerPlanCoverage('ありがとうございます。',{items:[{questionId:'Q1',topic:'SIZE',status:'NEEDS_CHECK',evidenceRefs:[],answerConstraints:[]}]});assert.equal(result.hasLikelyGap,true);});
 check('unverified item condition cannot be borrowed from another reply',()=>assert(ap.detectUngroundedPromises('商品状態は同等程度であることを確認しております。').includes('複数商品の状態の断定')));
 console.log(JSON.stringify({passed,externalWrites:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});

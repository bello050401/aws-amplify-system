const assert=require('node:assert/strict'),vm=require('node:vm'),{build}=require('esbuild');
(async()=>{
 let role='ADMIN',calls=[],pages={},conversation={id:'c1'},message={id:'m1',conversationId:'c1'},failed=false;
 class GetCommand{constructor(input){this.input=input;}}
 class QueryCommand{constructor(input){this.input=input;}}
 const ports={
  'server-only':{},'@aws-sdk/lib-dynamodb':{GetCommand,QueryCommand},
  '@/lib/amplify/directData':{directTableName:n=>n},
  '@/lib/inventory/mutationSession':{inventoryVerifiedReadSession:async()=>role?{role,owner:'user'}:null},
  '@/lib/messaging/service':{toConversationRecord:x=>x,toMessageRecord:x=>x},
  '@/lib/inquiry/draftStore':{toReplyDraftRecord:x=>x},
  './store':{inquiryDb:{send:async cmd=>{calls.push(cmd.input);if(failed)throw Error('unavailable');if(cmd instanceof GetCommand)return {Item:cmd.input.TableName==='Conversation'?conversation:message};return (pages[cmd.input.TableName]??[]).shift()??{Items:[]};}}},
 };
 const result=await build({entryPoints:['lib/inquiry/runtime/viewStore.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in ports?{path:a.path,external:true}:undefined);}}]});
 const module={exports:{}};vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:n=>{assert(n in ports);return ports[n];}});
 const {readInquiryConversationView:read,readInquiryMessage:photo}=module.exports;
 let passed=0;
 for(role of [null,'VIEWER','Admins','untrusted']) {calls=[];await assert.rejects(()=>read('c1'),/操作権限/);await assert.rejects(()=>photo('c1','m1'),/操作権限/);assert.equal(calls.length,0);passed++;}
 for(role of ['ADMIN','EDITOR']){calls=[];assert(await read('c1'));assert(calls.every(x=>x.TableName==='Conversation'||x.ExpressionAttributeValues[':conversation']==='c1'));passed++;}
 role='ADMIN';calls=[];await assert.rejects(()=>read(''));await assert.rejects(()=>read('x'.repeat(201)));assert.equal(calls.length,0);passed++;
 pages={Message:[{Items:[{id:'m2',conversationId:'c1',createdAt:'2'}],LastEvaluatedKey:{id:'m2'}},{Items:[] ,LastEvaluatedKey:{id:'m3'}},{Items:[{id:'m1',conversationId:'c1',createdAt:'1'}]}],ReplyDraft:[{Items:[{id:'d1',conversationId:'c1',createdAt:'1'},{id:'d2',conversationId:'c1',createdAt:'2'}]}]};
 const view=await read('c1');assert.equal(view.messages.map(x=>x.id).join(','),'m1,m2');assert.equal(view.drafts.map(x=>x.id).join(','),'d2,d1');passed++;
 pages={Message:[{Items:[{id:'other',conversationId:'c2'}]}]};await assert.rejects(()=>read('c1'),/対応/);passed++;
 conversation={id:'c1',deletedAt:'deleted'};calls=[];assert.equal(await read('c1'),null);assert.equal(calls.length,1);passed++;
 conversation={id:'c1'};message={id:'m1',conversationId:'c2'};assert.equal(await photo('c1','m1'),null);passed++;
 message={id:'m1',conversationId:'c1',body:'[送信取消]'};assert.equal((await photo('c1','m1')).body,'[送信取消]');passed++;
 failed=true;await assert.rejects(()=>read('c1'),/unavailable/);passed++;
 console.log(JSON.stringify({passed,failed:0,checks:'verified roles, no unauthorized reads, exact conversation, pagination, ordering, deleted records, attachment ownership, fail closed'}));
})().catch(e=>{console.error(e);process.exitCode=1;});

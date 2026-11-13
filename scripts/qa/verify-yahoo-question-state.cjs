const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');
(async () => {
  const writes = [], sends = [];
  let priorEvent;
  class Command { constructor(input) { this.input = input; } }
  class GetCommand extends Command {}
  class TransactWriteCommand extends Command {}
  const db = {send: async c => {
    if (c instanceof GetCommand) return {Item:c.input.Key.sk.startsWith('EVENT#') ? priorEvent : undefined};
    if (c instanceof TransactWriteCommand) { writes.push(c.input); priorEvent=c.input.TransactItems[0].Put.Item; }
    return {};
  }};
  const modules = {
    'server-only':{},
    '@aws-sdk/client-dynamodb':{DynamoDBClient:class {}},
    '@aws-sdk/lib-dynamodb':{DynamoDBDocumentClient:{from:()=>db},GetCommand,TransactWriteCommand,PutCommand:Command,QueryCommand:Command,UpdateCommand:Command},
    '@aws-sdk/client-sqs':{SQSClient:class {async send(c){sends.push(c.input);}},SendMessageCommand:Command},
    '@/lib/inquiry/runtime/config':{runtimeConfig:()=>({table:'qa-inbox',region:'qa',queueUrl:'qa-queue'})},
  };
  const built=await esbuild.build({entryPoints:['lib/inquiry/runtime/store.ts'],bundle:true,platform:'node',format:'cjs',write:false,
    plugins:[{name:'isolated-ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in modules?{path:a.path,external:true}:undefined);}}]});
  const sandbox={module:{exports:{}},exports:{},require:n=>n in modules?modules[n]:require(n),Buffer,URL,console,process};
  vm.runInNewContext(built.outputFiles[0].text,sandbox);
  const payload={channel:'YAHOO_AUCTION',params:{conversationId:'c1',sourceMessageId:'m1',who:null,yahooAuctionId:'q1249691645',productTitle:'arper Colina'}};
  await sandbox.module.exports.enqueueInquiry('YAHOO_AUCTION','qa','question:1','gmail:1',payload);
  assert.equal(writes.length,1);
  const update=writes[0].TransactItems[1].Update;
  assert.equal(update.ExpressionAttributeValues[':conversationId'],'c1');
  assert.equal(update.ExpressionAttributeValues[':question'].auctionId,'q1249691645');
  assert.equal(update.ExpressionAttributeValues[':question'].productName,'arper Colina');
  assert.equal(Object.keys(update.ExpressionAttributeValues[':question']).length,2);
  assert(!update.UpdateExpression.includes('ttl'));
  assert(writes[0].TransactItems[0].Put.Item.ttl);
  console.log('PASS 本文の期限付きイベントと別に、公開商品情報・回答リンクを受信時に保存');
  await sandbox.module.exports.enqueueInquiry('YAHOO_AUCTION','qa','question:1','gmail:1',payload);
  assert.equal(writes.length,1);assert.equal(sends.length,2);
  console.log('PASS 通信再試行で受信履歴・バージョンを増やさず、未完了キューだけを再試行');
})().catch(e=>{console.error(e);process.exitCode=1;});

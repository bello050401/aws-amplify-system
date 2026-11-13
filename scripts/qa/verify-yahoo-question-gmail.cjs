const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');
(async () => {
  const calls = [];
  let failing = false;
  const headers = (sender, auth) => [
    {name:'From',value:sender},
    {name:'Authentication-Results',value:'mx.google.com; dmarc='+auth+' header.from=mail.yahoo.co.jp'},
    {name:'Subject',value:'Yahoo!オークション - 質問：（q1249691645)'},
  ];
  const fake = async input => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    let data;
    if (url.pathname.endsWith('/token')) data = {access_token:'synthetic-test-token',expires_in:3600};
    else if (url.pathname.endsWith('/profile')) data = {emailAddress:'test@example.invalid',historyId:'200'};
    else if (url.pathname.endsWith('/history')) data = {historyId:'201',history:[{messagesAdded:[{message:{id:'new'}}]}]};
    else if (url.pathname.endsWith('/messages')) data = {messages:[{id:'question'}]};
    else {
      const id=url.pathname.split('/').at(-1);
      data={id,internalDate:'1794537221000',labelIds:id==='spam'?['SPAM']:['INBOX'],
        payload:{mimeType:'text/plain',body:{data:Buffer.from('synthetic question').toString('base64url')},headers:headers('auction-master@mail.yahoo.co.jp',id==='forged'?'fail':'pass')}};
    }
    return new Response(JSON.stringify(data),{status:failing ? 429 : 200});
  };
  const modules = {
    'server-only':{},
    './gmailSecretStore':{getGmailCredentials:async()=>({clientId:'test',clientSecret:'test',refreshToken:'test',query:'from:no-reply@mercari-shops.com'})},
    '@/lib/http/fetchWithTimeout':{fetchWithTimeout:fake},
  };
  const built=await esbuild.build({entryPoints:['lib/messaging/email/gmailClient.ts'],bundle:true,platform:'node',format:'cjs',write:false,
    plugins:[{name:'isolated-ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in modules?{path:a.path,external:true}:undefined);}}]});
  const sandbox={module:{exports:{}},exports:{},require:n=>n in modules?modules[n]:require(n),Buffer,URL,URLSearchParams,Response,console,process};
  vm.runInNewContext(built.outputFiles[0].text,sandbox);
  const api=sandbox.module.exports;
  const first=await api.readGmailDelta({historyId:'100'});
  assert.equal(first.next.questionMailVersion,1);
  const query=calls.find(s=>s.includes('/messages?'));
  assert(decodeURIComponent(query).includes('subject:質問'));
  assert(decodeURIComponent(query).includes('newer_than:90d'));
  assert.equal(calls.filter(s=>s.includes('/history?')).length,0);
  calls.length=0;
  const second=await api.readGmailDelta(first.next);
  assert.equal(second.next.historyId,'201');
  assert.equal(calls.filter(s=>s.includes('/messages?')).length,0);
  assert.equal(calls.filter(s=>s.includes('/history?')).length,1);
  console.log('PASS 初回だけ既存質問を取得し、次回からGmailの差分を取得');
  const mails=await api.fetchMercariNotificationMailsByIds(['real','forged','spam']);
  assert.equal(mails.length,1);assert.equal(mails[0].gmailId,'real');
  console.log('PASS 実受信経路が認証済みYahooだけを通し、なりすまし・迷惑メールを除外');
  failing=true;
  await assert.rejects(api.readGmailDelta(second.next));
  console.log('PASS 接続障害を未着0件として扱わない');
})().catch(e=>{console.error(e);process.exitCode=1;});

const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
(async()=>{
 // Never package the working folder: it may contain machine-local private config.
 const parent=path.resolve('artifacts/whole-instruction-20261107/packages');fs.mkdirSync(parent,{recursive:true});
 const out=fs.mkdtempSync(path.join(parent,'BELLO-Inquiry-Reader-'));
 for(const name of ['inquiryCloudWorker','inquiryLogin'])await esbuild.build({entryPoints:[`tools/bello-mercari-bridge/src/${name}.mjs`],outfile:path.join(out,name+'.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',minify:false});
 const root='${LOCALAPPDATA}/BELLO/InquiryReader';
 const config={origin:'https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com',root:root+'/Queue',belloProfileDir:root+'/BELLOChrome',profileDir:root+'/ShopsChrome',playwrightModulePath:'./node_modules/playwright/package.json',shopId:'evkhihBFFNn5hukMS9s36H'};
 fs.copyFileSync(process.execPath,path.join(out,'node.exe'));
 for(const name of ['playwright','playwright-core'])fs.cpSync(path.dirname(require.resolve(name+'/package.json')),path.join(out,'node_modules',name),{recursive:true});
 const nodeLicense=path.join(path.dirname(process.execPath),'LICENSE');
 if(fs.existsSync(nodeLicense))fs.copyFileSync(nodeLicense,path.join(out,'NODE-LICENSE.txt'));
 else {
  const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('NODE_LICENSE_UNAVAILABLE');const license=await response.text();
  if(!license.includes('Permission is hereby granted'))throw Error('NODE_LICENSE_INVALID');
  fs.writeFileSync(path.join(out,'NODE-LICENSE.txt'),license);
 }
 fs.writeFileSync(path.join(out,'config.json'),JSON.stringify(config,null,2));
 for(const [file,script] of [['1-Login.cmd','inquiryLogin'],['2-Read-once.cmd','inquiryCloudWorker'],['3-Start.cmd','inquiryCloudWorker']])fs.writeFileSync(path.join(out,file),'@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "'+script+'.mjs" "config.json"'+(file==='2-Read-once.cmd'?' --once':'')+'\r\npause\r\n');
 fs.writeFileSync(path.join(out,'はじめに.txt'),'BELLO 問い合わせ読取用\r\n\r\n1. ZIPを展開してください。Chromeが必要です。Node.jsは同梱済みです。\r\n2. 1-Login.cmdを開き、BELLOとメルカリShopsの2画面でログインしてください。両方の画面を閉じると設定を保存します。\r\n3. 2-Read-once.cmdで1回確認します。COMPLETEDは本文取得完了、WAITINGは現在の取得待ちがない状態です。\r\n4. 3-Start.cmdで継続して読み取ります。停止する場合はコマンド画面でCtrl+Cを押してください。\r\n\r\nログイン切れの場合は1に戻らず、1-Login.cmdで再ログインしてください。BELLOの問い合わせ画面で「本文の取得を再試行」を選べます。\r\nCONNECTION_RETRYは通信の再試行中です。ALREADY_RUNNINGの場合は既に起動している画面を確認してください。\r\n\r\nこのツールは本文の取得専用です。お客様への返信は送信しません。\r\n専用ログイン後の実会話26発言の取得・保存と短時間の待機を確認済みです。長期連続稼働は未検証です。\r\n通常のChromeの設定やログイン情報は読み取り・コピーしません。専用情報は各PCのLocalAppData/BELLO/InquiryReaderに保存します。\r\n','utf8');
 fs.copyFileSync('docs/inquiry-runtime-20261108.md',path.join(out,'Readme.md'));
 fs.writeFileSync(path.join(out,'version.json'),JSON.stringify({version:'2026-11-08',mode:'READ_ONLY',customerSending:false,requiresDedicatedLogin:true,nodeBundled:process.version,requiresChrome:true,dedicatedSessionReadAndSaveVerified:true,verifiedMessageCount:26,shortIdleCyclesVerified:3,longRunningVerified:false,newMissingBodyMailEndToEndVerified:false},null,2));
 console.log(JSON.stringify({out,mode:'READ_ONLY',readAndSaveVerified:true,longRunningVerified:false}));
})().catch(e=>{console.error(e.name);process.exitCode=1;});

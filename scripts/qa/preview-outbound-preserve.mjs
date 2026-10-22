/** Loopback UI rehearsal: actual component/service, in-memory DB and captured email only. */
import http from 'node:http';
import fs from 'node:fs';
import{createRequire}from'node:module';
const require=createRequire(import.meta.url);
import path from 'node:path';
import esbuild from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import {createOutboundFixture} from './outbound-preserve-fixture.mjs';
import {kawagoeAttachments} from '../../lib/outbound/kawagoe.ts';
const root=process.cwd(),fixture=createOutboundFixture();
if(process.argv.includes('--arrival-ready')){const batch=await fixture.prepare(3);await fixture.api.emailOutbound(batch.id,'QA');}
const bundle=await esbuild.build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{OutboundScreen}from'./app/inventory/(protected)/outbound/OutboundScreen';createRoot(document.getElementById('app')).render(location.pathname==='/app'?<div id='bello-outbound'><OutboundScreen embedded/></div>:<OutboundScreen/>);`,loader:'tsx',resolveDir:root},bundle:true,alias:{react:path.dirname(require.resolve('react/package.json')),'react-dom':path.dirname(require.resolve('react-dom/package.json'))},write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}});
const css=await postcss([tailwind({content:[path.join(root,'app/inventory/(protected)/outbound/*.tsx')],theme:{extend:{}},plugins:[]})]).process('@tailwind base;@tailwind components;@tailwind utilities;',{from:undefined});
const mobileCss=await postcss([tailwind({...require(path.join(root,'mobile/outbound.tailwind.cjs')),content:[path.join(root,'app/inventory/(protected)/outbound/*.tsx')]})]).process(fs.readFileSync(path.join(root,'mobile/outbound.css'),'utf8'),{from:undefined});
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1:8151');
  if(url.pathname.startsWith('/api/inventory/outbound')){
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){
      let body='';for await(const part of req)body+=part;const data=JSON.parse(body);let batch;
      if(data.action==='prepare'){batch=await fixture.api.prepareOutbound(data.id,data.destinationId,data.items,'QA',data.arrivalDate);batch=await fixture.api.emailOutbound(batch.id,'QA');}
      else if(data.action==='send')batch=await fixture.api.emailOutbound(data.id,'QA');
      else if(data.action==='arrive')batch=await fixture.api.confirmOutboundArrival(data.id,data.commandId,data.changes,'QA');
      else if(data.action==='cancel')batch=await fixture.api.cancelUnsentOutbound(data.id);
      else throw Error('Unsupported QA action');
      res.end(JSON.stringify({batch}));return;
    }
    if(url.searchParams.has('batch')&&url.searchParams.get('arrival')==='1'){res.end(JSON.stringify(await fixture.api.previewOutboundArrival(url.searchParams.get('batch'))));return;}
    if(url.searchParams.has('batch')){
      const batch=await fixture.api.getOutboundBatch(url.searchParams.get('batch'));
      if(url.searchParams.has('download')){const file=kawagoeAttachments(batch).find(f=>f.kind===url.searchParams.get('kind'));res.setHeader('Content-Type','text/csv; charset=Shift_JIS');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);res.end(file.data);return;}
      res.end(JSON.stringify({batch}));return;
    }
    if(url.pathname.endsWith('/settings')){res.end(JSON.stringify({categories:[...fixture.rows('Category').values()],locations:[...fixture.rows('Location').values()]}));return;}
    res.end(JSON.stringify(url.searchParams.has('destination')?{items:await fixture.api.outboundProducts(url.searchParams.get('destination'))}:{destinations:await fixture.api.outboundDestinations(),history:await fixture.api.outboundHistory(),canEdit:true,canConfigure:true}));return;
  }
  if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
  if(url.pathname==='/mobile.css'){res.setHeader('Content-Type','text/css');res.end(mobileCss.css);return;}
  if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  const header='<header style="background:#fff1df;padding:12px">出庫操作確認・隔離テスト（実送信なし） <a href="/state">保存データを確認</a></header>';
  const inventory=[...fixture.rows('Inventory').values()].map(row=>`<tr><td>${escape(row.sku)}</td><td>${escape(row.name)}</td><td>${row.quantity}</td><td>${row.categoryIds.map(id=>escape(fixture.read('Category',id).name)).join('・')}</td><td>${escape(fixture.read('Location',row.locationId)?.name)}</td></tr>`).join('');
  const state=`<h1>隔離テストの保存結果</h1><p>初期状態：1商品・数量5・販売中／川越移動予定・所沢事務所</p><p>外部への実送信：0件 ／ テスト内の送信受付：${fixture.effects.emails.length}回 ／ CSV：${fixture.effects.emails.flat().length}ファイル</p><table border="1" cellpadding="12"><tr><th>管理番号</th><th>商品名</th><th>数量</th><th>カテゴリ</th><th>保管場所</th></tr>${inventory}</table><p>履歴：${fixture.rows('InventoryHistory').size}件</p><a href="/">PC版へ</a>　<a href="/mobile">iPhone用画面へ</a>`;
  res.end('<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width, initial-scale=1"><title>川越出庫・カテゴリと保管場所の保持テスト</title><link rel="stylesheet" href="/style.css">'+(url.pathname==='/app'?'<link rel="stylesheet" href="/mobile.css"><style>body{height:100dvh;display:flex;flex-direction:column;margin:0}#app{display:flex;flex:1;min-height:0;flex-direction:column}.test-nav{background:#fff1df;padding:12px;text-align:center;flex-shrink:0;min-height:48px}</style>':'')+'<body style="font-family:Arial,sans-serif">'+(url.pathname==='/app'?'<div class="test-nav">出庫</div>':header)+(url.pathname==='/state'?state:url.pathname==='/mobile'?'<iframe title="iPhone用出庫画面" src="/app" style="display:block;width:390px;height:844px;margin:20px auto;border:1px solid #ccc"></iframe>':'<div id="app"></div><script src="/bundle.js"></script>')+(url.pathname==='/app'?'<div class="test-nav">ホーム　　在庫一覧　　出庫　　売上</div>':'')+'</body></html>');
}catch(error){res.statusCode=409;res.end(JSON.stringify({error:error.message}));}}).listen(8151,'127.0.0.1',()=>console.log('Isolated outbound UI: http://127.0.0.1:8151'));

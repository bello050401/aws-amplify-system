const path=require('node:path'),fs=require('node:fs'),http=require('node:http'),esbuild=require('esbuild');
const root=fs.realpathSync(path.resolve(__dirname,'../../..')),out=path.join(root,'artifacts/sale-desktop-ui');fs.mkdirSync(out,{recursive:true});
const link=path.join(out,'link.tsx');fs.writeFileSync(link,'import React from "react";export default function Link({children,...props}:React.ComponentProps<"a">){return <a {...props}>{children}</a>}');
esbuild.buildSync({absWorkingDir:root,entryPoints:[path.join(__dirname,'main.tsx')],bundle:true,outfile:path.join(out,'ui.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},alias:{'next/link':link},tsconfig:path.join(root,'tsconfig.json')});
const now=Date.now(),at=new Date(now).toISOString();let revision=0;
const shared={candidateId:'a'.repeat(64),inventoryId:'fixture-stock',inventoryVersion:'v1',externalId:'fixture-mercari',title:'検証用チェア（架空商品） ホワイト・木製脚',imageKeys:['fixture-photo'],orderId:'fixture-order',orderLineId:'1',snapshot:'fixture-snapshot',version:'v1',state:'WAITING',createdAt:at,updatedAt:at,nextAt:now+21600000,attempts:1,images:[{key:'fixture-photo',url:'/fixture.svg'}]};
let jobs=[{...shared,id:'1'.repeat(64),pk:'SALE_DESKTOP#'+('1'.repeat(64)),purpose:'STOCK',targetQuantity:2},{...shared,id:'2'.repeat(64),pk:'SALE_DESKTOP#'+('2'.repeat(64)),purpose:'VERIFY_SALE',title:'検証用ランプ（架空商品）'}];
const inventory={id:'fixture-stock',title:shared.title,version:'v1',externalId:'fixture-mercari',images:shared.images};
const html='<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BELLO 売却自動化 検証環境</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/ui.js"></script></html>';
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240"><rect width="300" height="240" fill="#edf2f1"/><rect x="95" y="40" width="110" height="85" rx="12" fill="#fff" stroke="#476e67" stroke-width="4"/><path d="M90 130 H210 V150 H90 Z M100 150 L85 205 M200 150 L215 205" fill="#d6c4a8" stroke="#476e67" stroke-width="5"/><text x="150" y="230" text-anchor="middle" font-size="15">架空のテスト商品</text></svg>';
async function start(){const result=await require('postcss')([require('tailwindcss')({content:[path.join(root,'components/sales/DesktopSaleJobs.tsx'),path.join(__dirname,'main.tsx')],theme:{extend:{}},plugins:[]})]).process('@tailwind base;@tailwind components;@tailwind utilities;body{font-family:system-ui,sans-serif}input,select,button{min-height:44px}',{from:undefined});
 http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');const u=new URL(req.url,'http://127.0.0.1');
 const json=(status,d)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(d));};
 if(u.pathname==='/api/sale-candidates/desktop-jobs'){
  if(req.method==='GET')return json(200,u.searchParams.has('inventoryId')?{inventory}:{jobs,cursor:null});
  if(req.method!=='POST')return json(405,{error:'検証環境で未対応'});
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>10000)return json(413,{error:'入力が長すぎます'});}let body;try{body=JSON.parse(raw);}catch{return json(400,{error:'入力形式'});}
  const j=jobs.find(v=>v.id===body.id);if(!j)return json(404,{error:'受付なし'});
  if(body.action==='claim'){j.state=j.writeStartedAt?'WRITE_STARTED':'CLAIMED';j.lease='fixture-lease';j.leaseUntil=Date.now()+900000;}
  else if(body.action==='start-write'){if(!body.evidence?.imageMatched||!body.evidence?.titleMatched)return json(400,{error:'照合が必要です'});j.state='WRITE_STARTED';j.writeStartedAt=new Date().toISOString();}
  else if(body.action==='report-error'){j.lastIssue={code:body.code,at:new Date().toISOString()};return json(200,{job:j,reported:true,operational:['AUTH_REQUIRED','RATE_LIMITED'].includes(body.code)});}
  else if(body.action==='finish'){if(j.purpose==='STOCK'&&body.evidence?.observedQuantity!==j.targetQuantity)return json(409,{error:'目標数量と確認数量が一致しません'});j.state='COMPLETE';j.completedAt=new Date().toISOString();}
  else return json(400,{error:'操作不明'});j.version='v'+(++revision);return json(200,{job:j});
 }
 if(req.method!=='GET')return json(405,{error:'変更不可'});
 if(u.pathname==='/ui.js'){res.setHeader('Content-Type','text/javascript');return fs.createReadStream(path.join(out,'ui.js')).pipe(res);}if(u.pathname==='/style.css'){res.setHeader('Content-Type','text/css');return res.end(result.css);}if(u.pathname==='/fixture.svg'){res.setHeader('Content-Type','image/svg+xml');return res.end(svg);}res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);
 }).listen(43143,'127.0.0.1',()=>console.log('Isolated sale UI http://127.0.0.1:43143'));
}
if(!process.argv.includes('--bundle-only'))start().catch(e=>{console.error(e);process.exitCode=1;});

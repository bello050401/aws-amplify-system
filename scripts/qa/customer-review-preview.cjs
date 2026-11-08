// Local-only synthetic UI fixture using production components; no API or customer records.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const dir=path.resolve('artifacts/customer-ai-20261108/ui');
(async()=>{
 fs.mkdirSync(dir,{recursive:true});
 await require('esbuild').build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import Panel from './app/inventory/(protected)/messages/ReplyReviewPanel';
 import {calculateInquiryQuote} from './lib/inquiry/quote';
 import {copyValidatedInquiryText} from './lib/inquiry/copyText';
 const rate:any={id:'test-rate',provider:'アートセッティングデリバリー',service:'らくらく家財便',originPrefecture:'埼玉県',destinationPrefecture:'東京都',destinationArea:null,rank:'B',price:4510,taxIncluded:true,currency:'JPY',effectiveFrom:'2026-11-08',effectiveTo:null,verifiedAt:new Date().toISOString(),status:'VERIFIED',sourceReference:'確認用の料金表',version:2,updatedAt:new Date().toISOString()};
 const quote=calculateInquiryQuote({at:new Date().toISOString(),asOfDate:'2026-11-08',origin:'埼玉県',destination:'東京都',service:'KAZAI',ranks:['B'],packagesConfirmed:true,quantity:1,unitPriceYen:50000,policy:{id:'test-inclusive',version:'1',mode:'INCLUDED',approved:true},rates:[rate]});
 const evidence:any={quote,product:null,productStatus:'RESOLVED',productCandidates:[],inventoryFieldsUsed:[],knowledgeDocuments:[],shipping:null,externalResearchAttempted:false,externalFacts:[],unresolvedFacts:[]};
 function App(){const [text,setText]=useState('こちらは送料込みで、合計50,000円です。'),[status,setStatus]=useState('');
 return <main className="mx-auto max-w-3xl p-4"><h1 className="text-xl font-bold">返信の確認（テスト用）</h1><p className="my-2 text-sm text-slate-500">架空の商品です。顧客への送信・商品変更は行いません。</p><label className="block font-semibold" htmlFor="draft">返信案</label><textarea id="draft" className="mt-2 min-h-32 w-full rounded-xl border p-3 text-base" value={text} onChange={e=>setText(e.target.value)}/><button className="min-h-11 rounded-lg bg-teal-800 px-4 py-2 text-white" onClick={async()=>{try{await copyValidatedInquiryText(text,()=>new Promise<void>(resolve=>setTimeout(resolve,300)));setStatus('コピーしました')}catch{setStatus('コピー失敗')}}}>返信案をコピー</button><p role="status">{status}</p><Panel evidence={evidence} text={text}/></main>}
 createRoot(document.getElementById('root')!).render(<App/>);
 `},outfile:path.join(dir,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const cssDir='.next/static/css';let css='';for(const file of fs.readdirSync(cssDir))if(file.endsWith('.css'))css+=fs.readFileSync(path.join(cssDir,file),'utf8');fs.writeFileSync(path.join(dir,'style.css'),css);
 fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>返信確認テスト</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
 if(process.argv.includes('--build-only'))return;
 http.createServer((req,res)=>{const file=({'/':'index.html','/app.js':'app.js','/style.css':'style.css'})[req.url];if(!file){res.writeHead(404);return res.end();}res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',file.endsWith('js')?'text/javascript':file.endsWith('css')?'text/css':'text/html;charset=utf-8');res.end(fs.readFileSync(path.join(dir,file)));}).listen(43141,'127.0.0.1',()=>console.log('Synthetic UI preview: http://127.0.0.1:43141/'));
})().catch(e=>{console.error(e.name);process.exitCode=1});

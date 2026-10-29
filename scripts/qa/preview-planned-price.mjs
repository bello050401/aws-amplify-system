import http from 'node:http';
import esbuild from 'esbuild';
import path from 'node:path';
import {createRequire} from 'node:module';
import {savePlannedPrice} from '../../lib/inventory/plannedPriceCore.ts';
import {isPriceEntryTarget} from '../../lib/inventory/plannedPrice.ts';
const require=createRequire(import.meta.url),rows=new Map();
const image='/chair.svg';
for(let n=1;n<=45;n++){const id=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;rows.set(id,{id,sku:'QA-'+n,name:n===1?'ウッドチェア オーク':'確認用商品 '+n,note:n===1?'座面に薄い傷あり':'',categoryIds:['r'],quantity:5,locationId:'office',plannedSalePrice:null,updatedAt:'2026-10-29T00:00:00.000Z',imageUrl:image});}
const port={get:async id=>structuredClone(rows.get(id)),categories:async()=>[{id:'r',name:'補修待ち'}],save:async(before,patch)=>{if(rows.get(before.id).updatedAt!==before.updatedAt)throw Object.assign(Error('別の端末で更新されました'),{code:'CONFLICT'});rows.set(before.id,{...rows.get(before.id),...patch});}};
const bundle=await esbuild.build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{PriceEntryScreen}from'./components/inventory/PriceEntryScreen';createRoot(document.getElementById('app')).render(<PriceEntryScreen embedded={location.pathname==='/mobile'} onClose={()=>location.href='/'} />);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,alias:{react:path.dirname(require.resolve('react/package.json')),'react-dom':path.dirname(require.resolve('react-dom/package.json'))},write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}});
http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1:8152');
 if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
 if(url.pathname===image){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#efede8"/><path d="M55 95V35H140V100M55 150V95H140V155M55 98H140" stroke="#97774e" stroke-width="15" fill="none"/></svg>');return;}
 if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');let data=null;if(req.method!=='GET'){let body='';for await(const c of req)body+=c;data=JSON.parse(body);}
 if(url.pathname==='/api/inventory/planned-price'){res.end(JSON.stringify(data?{item:await savePlannedPrice(port,data,'QA')}:{items:[...rows.values()].filter(r=>isPriceEntryTarget(r,['r']))}));return;}
 if(url.searchParams.has('images')){res.end(JSON.stringify({items:[...rows.values()].map(r=>({id:r.id,thumbnailUrl:image}))}));return;}
 const item=rows.get(url.pathname.split('/').pop());res.end(JSON.stringify({item:{...item,thumbnailUrl:image,unit:'点',location:'所沢事務所',category:'補修待ち',condition:'',barcode:'',photosComplete:true,photos:[{id:'inventory-fixture',source:'INVENTORY',url:image,fullUrl:image,primary:true}]}}));return;}
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><title>販売予定価格入力・隔離確認</title><style>body{margin:0}#app{height:100dvh;display:flex;flex-direction:column}</style><div id="app"></div><script src="/bundle.js"></script></html>');
 }catch(e){res.statusCode=409;res.end(JSON.stringify({error:e.message,code:e.code||'UNCONFIRMED'}));}}).listen(8152,'127.0.0.1',()=>console.log('Isolated price-entry UI http://127.0.0.1:8152'));

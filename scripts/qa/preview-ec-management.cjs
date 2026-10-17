/** Loopback-only UI harness. All server actions are replaced at bundle time; no marketplace credentials are loaded. */
const esbuild = require("esbuild"),
  http = require("node:http"),
  path = require("node:path");
const root = path.resolve(__dirname, "../..");
process.chdir(root);
const fixture = `
const state=globalThis.__ecPreview??=( {archived:[],published:[],stopped:[],attempts:{}} );
const rows=Array.from({length:80},(_,i)=>({inventoryId:'preview-'+i,displayId:'B'+String(5810+i).padStart(6,'0'),name:['Herman Miller イームズ シェルチェア','Vitra ワークチェア ブラック','カリモク ダイニングテーブル','Bello Select サイドテーブル'][i%4]+' '+(i+1),quantity:i%4,price:12000+i*500,thumbnailKey:null,inventoryUpdatedAt:'2026-10-17T00:00:00Z',hasDraft:i!==1,channelListing:null}));
const catalog=()=>({channels:Object.fromEntries(['MERCARI_SHOPS','YAHOO','BASE'].map(c=>[c,Object.fromEntries(rows.map((r,i)=>[r.inventoryId,{state:state.stopped.includes(c+':'+r.inventoryId)?'STOPPED':state.published.includes(c+':'+r.inventoryId)?'ACTIVE':i%3===0?'ACTIVE':i%3===1?'UNLISTED':'STOPPED',externalId:i%3===1?null:'listing-'+i,url:null,checkedAt:null}]))])),archivedIds:state.archived,errors:[]});
`;
const mocks = {
  "next/link": `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`,
  "../../InventoryThumbnail": `import React from 'react';export function InventoryThumbnail(){return <div className="flex h-full w-full items-center justify-center bg-stone-100 text-xs text-stone-400">写真</div>}`,
  "@/app/actions/listing":
    fixture +
    `export const listListingsOverviewSafeAction=async()=>({ok:true,rows});export const bulkCreateListingDraftsAction=async(ids)=>({created:ids,skipped:[],failed:[]});export const exportMercariShopsCsvAction=async()=>({ok:false,blockedRows:[]});`,
  "@/app/actions/ecListingCatalog": fixture + `export const getEcListingCatalogAction=async()=>catalog();`,
  "@/app/actions/ecListingOperations":
    fixture +
    `
export async function reviewEcListingAction(inventoryId,channel,operation){const r=rows.find(r=>r.inventoryId===inventoryId);return {inventoryId,title:r.name,channel,operation,status:operation==='PUBLISH'&&!r.hasDraft?'BLOCKED':'READY',price:r.price,quantity:r.quantity,imageCount:3,token:'preview',message:operation==='PUBLISH'&&!r.hasDraft?'共通の商品情報を保存してください。':operation==='ARCHIVE'?'EC一覧から削除します。在庫と販売先の商品は残ります。':'内容を確認してください。',requiresTerms:channel==='YAHOO'&&operation==='PUBLISH'};}
export async function executeEcListingAction(review){await new Promise(r=>setTimeout(r,300));if(review.operation==='ARCHIVE')state.archived.push(review.inventoryId);if(review.operation==='RESTORE')state.archived=state.archived.filter(id=>id!==review.inventoryId);if(review.operation==='PUBLISH')state.published.push(review.channel+':'+review.inventoryId);if(review.operation==='STOP')state.stopped.push(review.channel+':'+review.inventoryId);return {...review,status:'DONE',message:'テスト操作が完了しました。'};}
`,
};
(async () => {
  const bundle = await esbuild.build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ListingsOverviewTable} from './app/inventory/(protected)/listings/ListingsOverviewTable';${fixture}createRoot(document.getElementById('app')).render(<ListingsOverviewTable initialResult={{ok:true,rows}} canEdit/>);`,
      loader: "tsx",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "no-real-actions",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (a) =>
            Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: "mock" } : null,
          );
          build.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
            contents: mocks[a.path],
            loader: "tsx",
            resolveDir: root,
          }));
        },
      },
    ],
  });
  const css = await require("postcss")([
    require("tailwindcss")({
      content: [path.join(root, "app/inventory/(protected)/listings/*.tsx")],
      theme: { extend: {} },
      plugins: [],
    }),
    require("autoprefixer"),
  ]).process("@tailwind base;@tailwind components;@tailwind utilities;", { from: undefined });
  const server = http.createServer((req, res) => {
    if (req.url === "/preview.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].text);
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(css.css);
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EC一覧の操作確認（テストデータ）</title><link rel="stylesheet" href="/style.css"><body style="margin:0;font-family:Arial,sans-serif"><header style="background:#fff1df;padding:16px;font-weight:bold">Bello.　EC出品 <small>操作確認用のテストデータ</small></header><main id="app" style="padding:24px"></main><script src="/preview.js"></script></body></html>',
      );
    }
  });
  server.listen(8144, "127.0.0.1", () => console.log("EC preview: http://127.0.0.1:8144 (test data only)"));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

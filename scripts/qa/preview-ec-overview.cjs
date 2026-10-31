const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  { build } = require("esbuild");
const root = process.cwd(),
  dir = path.join(root, "artifacts/ec-overview-20261101");
fs.mkdirSync(dir, { recursive: true });
const table = "app/inventory/(protected)/listings/ListingsOverviewTable.tsx",
  shipping =
    "app/inventory/(protected)/[id]/listing/ShippingPackageReference.tsx";
const stubs = {
  "next/link": `import React from 'react';export default function Link(p){return <a {...p}/>}`,
  "@/app/actions/ecListingCatalog": `export async function getEcListingCatalogAction(){return window.fixture.catalog}`,
  "@/app/actions/listing": `export async function listListingsOverviewSafeAction(){return window.fixture.initial}`,
  "@/app/actions/econveniManualSync": `export async function econveniManualSyncAction(){throw Error('External writes disabled')}`,
  "../../InventoryThumbnail": `import React from 'react';export function InventoryThumbnail(p){return <img src={window.fixture.image} alt={p.alt}/>}`,
  "../../usePrimaryPhotoThumbnails": `export function usePrimaryPhotoThumbnails(){return {}}`,
  "./EcBulkDialog": `import React from 'react';export function EcBulkDialog(p){return <dialog open><p>確認対象：{p.items.length}件 / {p.action.kind}</p><button onClick={p.onClose}>閉じる</button></dialog>}`,
  "./EconveniManualDialog": `import React from 'react';export function EconveniManualDialog(p){return <dialog open>確認用・送信しません<button onClick={p.onClose}>閉じる</button></dialog>}`,
  "@/app/actions/shipping": `export async function getShippingPackageQuoteDataAction(){return window.fixture.shipping}`,
};
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{ListingsOverviewTable}from'./${table}';import{ShippingPackageReference}from'./${shipping}';import{JAPAN_PREFECTURES}from'./lib/shipping/prefectures';import{KAZAI_PROVIDER_NAME,KAZAI_SERVICE_NAME}from'./lib/shipping/serviceName';
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><rect width="140" height="140" fill="#eeeae4"/><rect x="37" y="36" width="66" height="48" rx="10" fill="#665b50"/><path d="M34 83h72v9H34zm5 9h6v27h-6zm57 0h6v27h-6z" fill="#594a3c"/></svg>');
const channels=['MERCARI_SHOPS','YAHOO','BASE'];const rows=Array.from({length:6},(_,i)=>({inventoryId:'stock'+i,displayId:'B005'+i,name:['【配送情報確認中】デンマーク J.L. Moller/J.L.モラー 名作 ダイニングテーブル 北欧モダン ナチュラル オイル仕上げ / 関連:カールハンセン フレデリシア','Molteni&C Glove Chair / モダン デザイナーズ パーソナルチェア','Vitra ID Air / デスクチェア'][i%3],quantity:i?5:0,price:120000,channelPrices:{MERCARI_SHOPS:125000,YAHOO:120000,BASE:118000},categories:i?['販売中']:['売り切れ'],thumbnailKey:null,inventoryUpdatedAt:'2026-11-01',hasDraft:true,channelListing:null,soldChannel:i?null:'YAHOO'}));
const catalog={channels:Object.fromEntries(channels.map(c=>[c,Object.fromEntries(rows.map((r,i)=>[r.inventoryId,{state:i?'ACTIVE':c==='YAHOO'?'ACTIVE':'UNLISTED',source:'ECONVENI',externalId:c+i,url:null,checkedAt:'2026-11-01'}]))])),errors:[],archivedIds:[],econveni:{checkedAt:'2026-11-01T00:00:00Z',products:rows.map((r,i)=>({inventoryId:r.inventoryId,inventory:r,product:{productId:String(i),title:r.name.replace(/【.*?】/,''),imageUrl:image,quantity:r.quantity,price:r.price,inventoryMarker:null,channels:Object.fromEntries(channels.map(c=>[c,{state:'ACTIVE',listingId:c+i,listingUrl:null}]))}}))}};
catalog.econveni.products.push({inventoryId:null,inventory:null,product:{...catalog.econveni.products[0].product,productId:'unlinked',title:'未連携の確認商品'}});
window.fixture={catalog,initial:{ok:true,rows},image,shipping:{asOfDate:'2026-11-01',estimatedRank:'A',plannedPrice:10000,rates:JAPAN_PREFECTURES.flatMap((p,i)=>(p==='北海道'?['道南','道央','道北','道東']:[null]).map(a=>({provider:KAZAI_PROVIDER_NAME,service:KAZAI_SERVICE_NAME,originPrefecture:'埼玉県',destinationPrefecture:p,destinationArea:a,rank:'A',price:1000+i,taxIncluded:true,currency:'JPY',surcharge:null,effectiveFrom:'2026-01-01',effectiveTo:null,verifiedAt:'2026-01-01',status:'VERIFIED',version:1}))).reverse()}};
createRoot(document.getElementById('root')).render(location.search.includes('shipping')?<div style={{maxWidth:420,margin:'40px auto'}}><ShippingPackageReference inventoryId="fixture" packages={[{id:'main',name:'',rank:'A'}]} goodsPrice={10000}/></div>:<ListingsOverviewTable initialResult={window.fixture.initial} canEdit={true}/>);`;
(async () => {
  await build({
    stdin: { contents: source, resolveDir: root, loader: "tsx" },
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: path.join(dir, "ui.js"),
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "isolated-ui",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
            contents: stubs[a.path],
            loader: "tsx",
            resolveDir: root,
          }));
        },
      },
    ],
  });
  const css = await require("postcss")([
    require("tailwindcss")({
      content: [table, shipping],
      theme: { extend: {} },
      plugins: [],
    }),
  ]).process("@tailwind base;@tailwind components;@tailwind utilities;", {
    from: undefined,
  });
  fs.writeFileSync(path.join(dir, "ui.css"), css.css);
  const html =
    '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BELLO EC一覧確認</title><link rel="stylesheet" href="/ui.css"><style>body{font-family:system-ui;margin:0;background:white}header{height:70px;padding:20px;border-bottom:1px solid #ddd;font-weight:bold}main{padding:24px;margin-left:64px}aside{position:fixed;top:70px;bottom:0;width:64px;border-right:1px solid #ddd;padding:12px 5px;font-size:11px}</style><header>BELLO　EC出品 <small style="color:#777">動作確認用・外部送信なし</small></header><aside>在庫一覧<br><br>売却管理<br><br>EC出品</aside><main id="root"></main><script src="/ui.js"></script></html>';
  fs.writeFileSync(path.join(dir, "ui.html"), html);
  if (process.argv.includes("--build-only")) return;
  http
    .createServer((req, res) => {
      if (req.headers.host !== "127.0.0.1:43136") {
        res.writeHead(403);
        return res.end();
      }
      const p = new URL(req.url, "http://127.0.0.1").pathname;
      if (!["/", "/ui.css", "/ui.js"].includes(p)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type":
          p === "/"
            ? "text/html;charset=utf-8"
            : p.endsWith(".css")
              ? "text/css"
              : "application/javascript",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;",
      });
      res.end(p === "/" ? html : fs.readFileSync(path.join(dir, p.slice(1))));
    })
    .listen(43136, "127.0.0.1", () =>
      console.log("Preview http://127.0.0.1:43136/"),
    );
})();

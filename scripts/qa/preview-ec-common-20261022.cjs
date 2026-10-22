/** Loopback-only UI harness. All server actions are replaced at bundle time; no marketplace credentials are loaded. */
const esbuild = require("esbuild"),
  http = require("node:http"),
  path = require("node:path");
const root = path.resolve(__dirname, "../..");
process.chdir(root);
const fixture = `
const state=globalThis.__ecPreview??=( {archived:[],published:[],stopped:[],attempts:{}} );
const rows=Array.from({length:80},(_,i)=>({inventoryId:'preview-'+i,displayId:'B'+String(5810+i).padStart(6,'0'),name:['Herman Miller イームズ シェルチェア','Vitra ワークチェア ブラック','カリモク ダイニングテーブル','Bello Select サイドテーブル'][i%4]+' '+(i+1),quantity:i%4,price:12000+i*500,thumbnailKey:null,inventoryUpdatedAt:new Date(Date.UTC(2026,9,1+i%20)).toISOString(),inventoryCreatedAt:new Date(Date.UTC(2026,8,1+i%25)).toISOString(),categories:[['補修待ち','撮影待ち','出品待ち'][i%3]],archived:i===79,channelPrices:{MERCARI_SHOPS:15000+i*500,YAHOO:12000+i*500,BASE:14250+i*475},hasDraft:i!==1,channelListing:null}));
const catalog=()=>({channels:Object.fromEntries(['MERCARI_SHOPS','YAHOO','BASE'].map(c=>[c,Object.fromEntries(rows.map((r,i)=>[r.inventoryId,{state:state.stopped.includes(c+':'+r.inventoryId)?'STOPPED':state.published.includes(c+':'+r.inventoryId)?'ACTIVE':i%3===0?'ACTIVE':i%3===1?'UNLISTED':'STOPPED',externalId:i%3===1?null:'listing-'+i,url:null,checkedAt:null}]))])),archivedIds:state.archived,errors:[]});
`;
const mocks = {
 "expo-image":`export {Image} from 'react-native';`,
 "@expo/vector-icons/Ionicons":`import React from 'react';export default function Icon(){return <span>×</span>};`,
 "@/app/actions/shipping":`export const getShippingPackageQuoteDataAction=async()=>({rates:[],asOfDate:'2026-10-22'});`,

 "@/lib/amplify/configureClient":'export function ConfigureAmplifyClientSide(){return null}',
 "aws-amplify/storage":`export const getUrl=async({path})=>({url:'/test-image?key='+encodeURIComponent(path)});export function uploadData({path,data}){return {result:fetch('/test-image?key='+encodeURIComponent(path),{method:'POST',body:data}).then(r=>{if(!r.ok)throw Error('upload failed');return {path}})}}`,
 "@/app/actions/listingImages":`export const getListingOriginalDownloadAction=async(_id,key)=>({ok:true,url:'/test-image?key='+encodeURIComponent(key)+'&download=1'});`,
 "@/app/actions/photoRegistration":`export const listInventoryPrimaryPhotoThumbnailsAction=async()=>({ok:true,value:[]});export const listInventoryPhotoAssetsAction=async()=>({ok:true,value:{assets:[]}});export const setListingPhotoAssetSelectionAction=async()=>({ok:true,value:{}});export const deleteInventoryPhotoAssetAction=async(_id,id)=>({ok:true,value:{photoAssetId:id}});export const setPhotoAssetPrimaryAction=async()=>({ok:true});export const updatePhotoAssetMetadataAction=async()=>({ok:true});`,
 "@/app/actions/ai":`export const generateListingCopyAction=async()=>{throw Error('対象外')};`,
 "@/app/actions/brandLogo":`export const createBrandedListingImageAction=async()=>{throw Error('対象外')};export const uploadBrandLogoAction=async()=>{throw Error('対象外')};`,

  "next/link": `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`,
  "../../InventoryThumbnail": `import React from 'react';export function InventoryThumbnail({storageKey,directUrl,alt,size}){return storageKey||directUrl?<img alt={alt} src={directUrl||('/test-image?key='+encodeURIComponent(storageKey))} style={{height:size==='heroContain'?260:100,width:'100%',objectFit:'contain'}}/>:<div>写真なし</div>}`,
  "@/app/actions/listing":
    fixture +
    `export const saveListingDraftAction=async (id,input)=>{const saved={id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',inventoryId:id,...input,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};localStorage.setItem('common-draft',JSON.stringify(saved));return saved;};export const listListingsOverviewSafeAction=async()=>({ok:true,rows});export const getBaseChannelListingAction=async()=>null;export const saveBaseChannelOverrideAction=async()=>({});export const getMercariFurnitureCategoryTreeAction=async()=>[];`,
  "@/app/actions/ecListingPresets": `import {DEFAULT_EC_PRESETS} from './lib/listing/ecPresets';let rows=structuredClone(DEFAULT_EC_PRESETS);export const listEcPresetsAction=async()=>rows.filter(p=>!p.deleted);export const saveEcPresetAction=async(p)=>{const saved={...p,revision:p.revision+1};rows=[...rows.filter(r=>r.id!==p.id),saved];return saved;};`,
  "@/app/actions/yahooAuctionWorkflow": `export const searchYahooCategoriesAction=async()=>({ok:true,value:[{id:'12345',path:'家具 > 椅子'}]});`,
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
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ListingsOverviewTable} from './app/inventory/(protected)/listings/ListingsOverviewTable';import {EcPresetManager} from './app/inventory/(protected)/settings/EcPresetManager';import {BaseListingEditor} from './app/inventory/(protected)/[id]/listing/BaseListingEditor';import {ListingForm} from './app/inventory/(protected)/[id]/listing/ListingForm';import {OutboundScreen} from './app/inventory/(protected)/outbound/OutboundScreen';import {InventoryPhotos} from './mobile/src/ui/InventoryPhotos';${fixture}function Common(){const [packages,setPackages]=React.useState([{id:'main',name:'',rank:'B'}]);const [method,setMethod]=React.useState('KAZAI');return <ListingForm inventoryId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' inventoryName='確認用 チェア' availableQuantity={5} brandLogoAvailable={false} images={[]} photoAssets={[]} initialDraft={JSON.parse(localStorage.getItem('common-draft')||'null')} initialChannelListing={null} canPrepareMercari={true} shippingMethod={method} onShippingMethodChange={setMethod} shippingPackages={packages} onShippingPackagesChange={setPackages} estimatedShippingRank='B'/>;}function Photos(){const [photos,setPhotos]=React.useState([{id:'photo-1',source:'PHOTO_ASSET',url:'/photo.jpg',type:'NORMAL',primary:true},{id:'photo-2',source:'INVENTORY',url:'/photo.jpg',type:'NORMAL'}]);return <div style={{width:390,margin:'auto'}}><InventoryPhotos item={{id:'test',name:'画像削除の確認',photos,updatedAt:'2026-10-22'}} onDeleteAsset={async id=>{setPhotos(p=>p.filter(i=>i.id!==id))}} onRemove={id=>setPhotos(p=>p.filter(i=>i.id!==id))}/></div>;}createRoot(document.getElementById('app')).render(location.pathname==='/mobile-photos'?<Photos/>:location.pathname==='/common'?<Common/>:location.pathname==='/outbound'?<OutboundScreen embedded/>:location.pathname==='/settings'?<EcPresetManager isAdmin/>:location.pathname==='/base'?<BaseListingEditor inventoryId="test" draft={{title:'チェア',description:'説明',price:29800,images:[{storageKey:'test',sortOrder:0}]}}/>:<ListingsOverviewTable initialResult={{ok:true,rows}} canEdit/>);`,
      loader: "tsx",
      resolveDir: root,
    },
    bundle: true,
    alias: {'react-native':require.resolve('react-native-web',{paths:[path.join(root,'mobile')]}),react:path.dirname(require.resolve("react/package.json")), "react-dom":path.dirname(require.resolve("react-dom/package.json"))},
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
            Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: "mock" } : a.path.includes("InventoryThumbnail") ? {path:"../../InventoryThumbnail",namespace:"mock"} : null,
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
      content: [path.join(root,"app/inventory/(protected)/outbound/*.tsx"),path.join(root, "app/inventory/(protected)/listings/*.tsx"),path.join(root,"app/inventory/(protected)/settings/EcPresetManager.tsx"),path.join(root,"app/inventory/(protected)/[[]id]/listing/*.tsx")],
      theme: { extend: {} },
      plugins: [],
    }),
    require("autoprefixer"),
  ]).process("@tailwind base;@tailwind components;@tailwind utilities;", { from: undefined });
  let lastBatch=null;const imageStore=new Map();
  const server = http.createServer((req, res) => {
    if(req.url==='/photo.jpg'){res.setHeader('Content-Type','image/jpeg');res.end(require('fs').readFileSync('C:/Users/win/Desktop/テスト/12 (4).JPG'));return;}
    if(req.url.startsWith('/test-image')){const u=new URL(req.url,'http://localhost'),key=u.searchParams.get('key');if(req.method==='POST'){const b=[];req.on('data',c=>b.push(c));req.on('end',()=>{imageStore.set(key,Buffer.concat(b));res.end('{}');});return;}const bytes=imageStore.get(key);if(!bytes){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','image/jpeg');if(u.searchParams.has('download'))res.setHeader('Content-Disposition','attachment; filename="original.jpg"');res.end(bytes);return;}
    const dest={id:'kawagoe',name:'川越',categoryId:'move',categoryName:'川越移動予定',locationId:'destination',locationName:'イエローテイル川越',templateType:'KAWAGOE_V1',sender:'DOWNLOAD',enabled:true,preparationStatus:'READY'};
    const item={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'元の商品名 チェア',sku:'TEST',barcode:'202610220001',quantity:5,updatedAt:'2026-10-22T00:00:00Z',locationName:'事務所',categoryNames:['川越移動予定']};
    if(req.url.startsWith('/api/inventory/outbound')){res.setHeader('Content-Type','application/json');
      if(req.method==='POST'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{const data=JSON.parse(body);lastBatch={id:data.id||'batch',destinationName:'川越',status:'AWAITING_SEND',createdAt:new Date().toISOString(),sender:'DOWNLOAD',templateType:'KAWAGOE_V1',arrivalDate:data.arrivalDate,orderNumber:'20261023入荷_1',rows:(data.items||[]).map(i=>({id:i.id,inventoryId:i.id,status:'PENDING',snapshot:{...item,quantity:i.quantity,exportName:i.exportName},sourceQuantity:5}))};res.end(JSON.stringify({batch:lastBatch}));});return;}
      res.end(JSON.stringify(req.url.includes('destination=')?{items:[item]}:{destinations:[dest],history:[],canEdit:true,canConfigure:false}));return;
    }

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
  server.listen(8146, "127.0.0.1", () => console.log("EC preview: http://127.0.0.1:8146 (test data only)"));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

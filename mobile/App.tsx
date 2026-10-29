import React, { useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { SnapshotStore } from "./src/domain/snapshot";
import { StaffApp, type StaffAppPorts } from "./src/ui/StaffApp";
import { previewItems, galleryPreviewItems } from "./src/preview/fixture";
import { InventoryWriteError } from "./src/domain/editor";
import { LiveApp } from "./src/ui/LiveApp";
import { nowInJst, shiftYearMonth } from "../lib/inventory/sales";
import { totalsFromAggregate } from "../lib/inventory/salesAggregate";
import { InventoryReadError } from "./src/domain/readError";
import { cachedInventorySearch, cachedSearchFields } from "./src/domain/search";
import {CatalogStore} from './src/domain/catalogStore';
import {catalogStorage} from './src/runtime/catalogStorage';
import {catalogBucket,compactCatalogItem,type CatalogDelta} from './src/domain/catalogProtocol';
import {View,Text,Pressable} from 'react-native';

function Preview() {
  const [staffPreview, setStaffPreview] = useState(false);
  const [offline, setOffline] = useState(false);
  const offlineRef = useRef(false);
  const refreshTest = useRef(__DEV__ && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("refresh-test") === "1").current;
  const readAttempt = useRef(0);
  const [catalogReads,setCatalogReads]=useState(0),[pageReads,setPageReads]=useState(0);
  const loadingTest = useRef(__DEV__ && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("loading-test") === "1").current;
  const quickSearchTest = useRef(__DEV__ && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("quick-search-test") === "1").current;
  const records = useRef(quickSearchTest ? Array.from({length:6000},(_,index)=>({...previewItems[index%3],id:`quick-preview-${index}`,sku:`QA-${index}`,name:`検索確認 チェア ${index}`,thumbnailUrl:null,quantity:index%10+1})) : __DEV__ && typeof window !== "undefined" && new URLSearchParams(window.location?.search).get("gallery-test") === "1"
    ? galleryPreviewItems() : previewItems.map((item,index) => ({ ...item, ...(__DEV__ && index===0 && typeof window!=='undefined' && new URLSearchParams(window.location.search).get('photo-delete-test')==='1' ? {photosComplete:true,photos:[{id:'photo-00000000-0000-4000-8000-000000000001',source:'PHOTO_ASSET' as const,url:'http://127.0.0.1:8146/photo.jpg',type:'NORMAL' as const,primary:true},{id:'preview-image',source:'INVENTORY' as const,url:'http://127.0.0.1:8146/photo.jpg',type:'NORMAL' as const,primary:false}]} : {}) })));
  const uploadedPhotos=useRef(new Map<string,string>());
  const ports = useMemo<StaffAppPorts>(() => ({
    snapshot: new SnapshotStore(loadingTest ? { ...AsyncStorage, setItem: async (key, value) => {
      await new Promise(resolve => setTimeout(resolve, 2500)); await AsyncStorage.setItem(key, value);
    } } : AsyncStorage, "ui-preview", loadingTest ? "loading-preview-only" : "preview-only"),
    ...(loadingTest ? {
      searchInventory: async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return { items: previewItems.map((item, index) => ({ ...item, quantity: [0, 1, 11][index] })), imagesDeferred: true, hasMore: true };
      },
      loadThumbnails: async () => {
        await new Promise(resolve => setTimeout(resolve, 3000));
        return previewItems.map(item => ({ id: item.id, updatedAt: item.updatedAt, thumbnailUrl: null }));
      },
    } : {}),
    ...(quickSearchTest ? {
      searchCatalogStore:new CatalogStore(catalogStorage,'ui-preview','quick-search-preview'),
      syncSearchCatalog:async(previous):Promise<CatalogDelta>=>{
        setCatalogReads(n=>n+1);await new Promise(resolve=>setTimeout(resolve,3000));
        const buckets=Array.from({length:64},()=>[] as typeof records.current);
        records.current.forEach(i=>buckets[catalogBucket(i.id)].push(compactCatalogItem(i)));
        buckets.forEach(b=>b.sort((a,b)=>a.id<b.id?-1:1));
        const hashes=await Promise.all(buckets.map(async b=>(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,JSON.stringify(b))).slice(0,32)));
        return {schema:2,hashes,total:records.current.length,checkedAt:new Date().toISOString(),buckets:buckets.flatMap((items,index)=>previous?.[index]===hashes[index]?[]:[{index,items}])};
      },
      searchInventory: async input=>{
        setPageReads(n=>n+1);await new Promise(resolve=>setTimeout(resolve,3000));
        const all=cachedInventorySearch(records.current,input,cachedSearchFields(records.current,{ecListing:true,sales:true})),offset=input.offset??0;
        return {items:all.slice(offset,offset+50),hasMore:offset+50<all.length,nextOffset:offset+50,total:all.length,totalQuantity:all.reduce((sum,item)=>sum+item.quantity,0)};
      },
    } : {}),
    online: async () => !offlineRef.current,
    newMutationId: () => Crypto.randomUUID(),
    loadOptions: async()=>({categories:["販売中","撮影待ち"],locations:["川越倉庫","所沢倉庫"],statuses:previewItems[0].statusOptions??[]}),
    deletePhotoAsset:async(id,photoId)=>{const item=records.current.find(r=>r.id===id);if(!item)throw Error('写真が見つかりません。');item.photos=item.photos?.filter(p=>p.id!==photoId);},
    uploadPhoto:async photo=>{uploadedPhotos.current.set(photo.id,photo.uri);return {storageKey:photo.id,type:photo.type};},
    checkBarcode:async(barcode,id)=>records.current.filter(r=>r.id!==id&&r.barcode===barcode).length,
    split:async request=>{
      const source=records.current.find(r=>r.id===request.inventoryId);if(!source||source.updatedAt!==request.expectedUpdatedAt)throw new InventoryWriteError('conflict');
      const updatedAt=new Date().toISOString(),remaining={...source,quantity:source.quantity-request.quantity,updatedAt};
      const child={...source,id:Crypto.randomUUID(),sku:'見本・分割',quantity:request.quantity,barcode:request.barcode,details:{...source.details,damageNotes:request.damageNotes},photos:[...(source.photos??[]),...request.photos.map(p=>({id:p.storageKey,type:p.type,primary:false,url:uploadedPhotos.current.get(p.storageKey)??null}))],updatedAt};
      records.current=[child,remaining,...records.current.filter(r=>r.id!==source.id)];return {source:remaining,split:child};
    },
    sell:async request=>{const source=records.current.find(r=>r.id===request.inventoryId);if(!source)throw new InventoryWriteError('conflict');return {source,sold:source};},
    loadInventory: async () => {
      if (refreshTest) {
        // Synthetic browser fixture: each read changes a visible value; the third read fails.
        const attempt = ++readAttempt.current;
        await new Promise(resolve => setTimeout(resolve, 1800));
        if (attempt === 3) throw new InventoryReadError("unavailable");
        return Array.from({ length: 20 }, (_, index) => ({ ...previewItems[index % previewItems.length],
          id: `refresh-preview-${index}`, name: `更新確認用 ${index + 1}`, quantity: attempt,
          updatedAt: `2026-10-17T01:00:${String(attempt).padStart(2, "0")}.000Z`,
        }));
      }
      return records.current.map(item => ({ ...item }));
    },
    loadDetail: async id => {
      const item = records.current.find(row => row.id === id);
      if (!item || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("detail-test") === "missing")) throw new InventoryReadError("not_found");
      return { ...item, photosComplete:true, details: { ...item.details }, photos: item.photos?.map(photo => ({ ...photo })) };
    },
    loadSales: async (year,month) => {
      const now=nowInJst(new Date());
      const totals=totalsFromAggregate({yearMonth:year+"-"+month,count:63,totalSales:2085000,totalCost:877000,totalPurchase:877000,totalProfit:1208000,totalShipping:29000},year,month);
      return {view:{year,month,status:"ok",totals,aggregateRebuiltAt:new Date().toISOString(),trend:Array.from({length:12},(_,index)=>({...shiftYearMonth(year,month,index-11),status:"ok" as const,totalSales:[4600000,4900000,5300000,4700000,6200000,6000000,7000000,8200000,7700000,5300000,7500000,2085000][index],totalGrossProfit:[3300000,3400000,3700000,3200000,4200000,4300000,4400000,5300000,5000000,3600000,5300000,1208000][index]}))},forecast:year===now.year&&month===now.month?{averageDailySales:122647,projectedMonthEndSales:3802057,month,today:now.day,totalDaysInMonth:31}:null,forecastUnavailable:false,items:[]};
    },
    removeInventory:async request=>{if(offlineRef.current)throw new InventoryWriteError("offline");const item=records.current.find(item=>item.id===request.id);if(item&&item.updatedAt!==request.expectedUpdatedAt)throw new InventoryWriteError("conflict");records.current=records.current.filter(item=>item.id!==request.id);},
    save: async (request) => {
      if (offlineRef.current) throw new InventoryWriteError("offline");
      const item = records.current.find((row) => row.id === request.id) ?? (request.create ? {...previewItems[0],id:request.id,sku:"見本・新規",name:"",details:{},photos:[],updatedAt:request.expectedUpdatedAt} : undefined);
      if (!item || item.updatedAt !== request.expectedUpdatedAt) throw new InventoryWriteError("conflict");
      const saved = { ...item, ...request.draft, quantity: Number(request.draft.quantity), plannedSalePrice: request.draft.plannedSalePrice === "" ? null : Number(request.draft.plannedSalePrice), updatedAt: new Date().toISOString() };
      saved.photos=[...((request.copyFrom ? records.current.find(item=>item.id===request.copyFrom!.id)?.photos : item.photos)??[]).filter(p=>!request.removedPhotoIds?.includes(p.id)),...(request.uploads??[]).map((photo,i)=>({id:photo.storageKey,url:null,type:photo.type,primary:!(item.photos?.length)&&i===0}))];
      records.current = [saved,...records.current.filter(row=>row.id!==saved.id)];
      return saved;
    },
  }), []);
  return <>{quickSearchTest&&<View><Text>確認専用：同期 {catalogReads} / サーバー検索 {pageReads}</Text><Pressable accessibilityRole="button" accessibilityLabel="検索データを2日前にして再起動" onPress={async()=>{const state=await ports.searchCatalogStore!.read();if(state){await ports.searchCatalogStore!.write({...state,checkedAt:new Date(Date.now()-2*86400000).toISOString()});window.location.reload();}}}><Text>2日後の再起動を確認</Text></Pressable></View>}<StaffApp ports={ports} offline={offline} preview writesEnabled canSellInventory={!staffPreview}
    features={{ ecListing: !staffPreview, sales: !staffPreview }}
    previewAccount={staffPreview ? "スタッフ" : "管理者"} onTogglePreviewAccount={() => setStaffPreview(value => !value)} onToggleOffline={() => {
    offlineRef.current = !offlineRef.current; setOffline(offlineRef.current);
  }} /></>;
}

export default function App() {
  const preview = __DEV__ && process.env.EXPO_PUBLIC_UI_PREVIEW === "1";
  return <SafeAreaProvider><StatusBar style="dark" />{preview ? <Preview /> : <LiveApp />}</SafeAreaProvider>;
}

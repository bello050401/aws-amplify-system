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

function Preview() {
  const [staffPreview, setStaffPreview] = useState(false);
  const [offline, setOffline] = useState(false);
  const offlineRef = useRef(false);
  const records = useRef(__DEV__ && typeof window !== "undefined" && new URLSearchParams(window.location?.search).get("gallery-test") === "1"
    ? galleryPreviewItems() : previewItems.map((item) => ({ ...item })));
  const uploadedPhotos=useRef(new Map<string,string>());
  const ports = useMemo<StaffAppPorts>(() => ({
    snapshot: new SnapshotStore(AsyncStorage, "ui-preview", "preview-only"),
    online: async () => !offlineRef.current,
    newMutationId: () => Crypto.randomUUID(),
    loadOptions: async()=>({categories:["販売中","撮影待ち"],locations:["川越倉庫","所沢倉庫"],statuses:previewItems[0].statusOptions??[]}),
    uploadPhoto:async photo=>{uploadedPhotos.current.set(photo.id,photo.uri);return {storageKey:photo.id,type:photo.type};},
    loadInventory: async () => records.current.map((item) => ({ ...item })),
    loadDetail: async id => {
      const item = records.current.find(row => row.id === id);
      if (!item || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("detail-test") === "missing")) throw new InventoryReadError("not_found");
      return { ...item, details: { ...item.details }, photos: item.photos?.map(photo => ({ ...photo })) };
    },
    loadSales: async (year,month) => {
      const now=nowInJst(new Date());
      const totals=totalsFromAggregate({yearMonth:year+"-"+month,count:63,totalSales:2085000,totalCost:877000,totalPurchase:877000,totalProfit:1208000,totalShipping:29000},year,month);
      return {view:{year,month,status:"ok",totals,aggregateRebuiltAt:new Date().toISOString(),trend:Array.from({length:12},(_,index)=>({...shiftYearMonth(year,month,index-11),status:"ok" as const,totalSales:[4600000,4900000,5300000,4700000,6200000,6000000,7000000,8200000,7700000,5300000,7500000,2085000][index],totalGrossProfit:[3300000,3400000,3700000,3200000,4200000,4300000,4400000,5300000,5000000,3600000,5300000,1208000][index]}))},forecast:year===now.year&&month===now.month?{averageDailySales:122647,projectedMonthEndSales:3802057,month,today:now.day,totalDaysInMonth:31}:null,forecastUnavailable:false,items:[]};
    },
    save: async (request) => {
      if (offlineRef.current) throw new InventoryWriteError("offline");
      const item = records.current.find((row) => row.id === request.id) ?? (request.create ? {...previewItems[0],id:request.id,sku:"見本・新規",name:"",details:{},photos:[],updatedAt:request.expectedUpdatedAt} : undefined);
      if (!item || item.updatedAt !== request.expectedUpdatedAt) throw new InventoryWriteError("conflict");
      const saved = { ...item, ...request.draft, quantity: Number(request.draft.quantity), plannedSalePrice: request.draft.plannedSalePrice === "" ? null : Number(request.draft.plannedSalePrice), updatedAt: new Date().toISOString() };
      saved.photos=[...(item.photos??[]),...(request.uploads??[]).map((photo,i)=>({id:photo.storageKey,url:null,type:photo.type,primary:!(item.photos?.length)&&i===0}))];
      records.current = [saved,...records.current.filter(row=>row.id!==saved.id)];
      return saved;
    },
  }), []);
  return <StaffApp ports={ports} offline={offline} preview writesEnabled
    features={{ ecListing: !staffPreview, sales: !staffPreview }}
    previewAccount={staffPreview ? "スタッフ" : "管理者"} onTogglePreviewAccount={() => setStaffPreview(value => !value)} onToggleOffline={() => {
    offlineRef.current = !offlineRef.current; setOffline(offlineRef.current);
  }} />;
}

export default function App() {
  const preview = __DEV__ && process.env.EXPO_PUBLIC_UI_PREVIEW === "1";
  return <SafeAreaProvider><StatusBar style="dark" />{preview ? <Preview /> : <LiveApp />}</SafeAreaProvider>;
}

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

function Preview() {
  const [staffPreview, setStaffPreview] = useState(false);
  const [offline, setOffline] = useState(false);
  const offlineRef = useRef(false);
  const records = useRef(__DEV__ && typeof window !== "undefined" && new URLSearchParams(window.location?.search).get("gallery-test") === "1"
    ? galleryPreviewItems() : previewItems.map((item) => ({ ...item })));
  const ports = useMemo<StaffAppPorts>(() => ({
    snapshot: new SnapshotStore(AsyncStorage, "ui-preview", "preview-only"),
    online: async () => !offlineRef.current,
    newMutationId: () => Crypto.randomUUID(),
    loadInventory: async () => records.current.map((item) => ({ ...item })),
    loadDetail: async id => {
      const item = records.current.find(row => row.id === id);
      if (!item) throw new Error("Not found");
      return { ...item, details: { ...item.details }, photos: item.photos?.map(photo => ({ ...photo })) };
    },
    save: async (request) => {
      if (offlineRef.current) throw new InventoryWriteError("offline");
      const item = records.current.find((row) => row.id === request.id);
      if (!item || item.updatedAt !== request.expectedUpdatedAt) throw new InventoryWriteError("conflict");
      const saved = { ...item, ...request.draft, quantity: Number(request.draft.quantity), plannedSalePrice: request.draft.plannedSalePrice === "" ? null : Number(request.draft.plannedSalePrice), updatedAt: new Date().toISOString() };
      records.current = records.current.map((row) => row.id === saved.id ? saved : row);
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

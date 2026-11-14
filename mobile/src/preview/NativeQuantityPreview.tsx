import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { quantityPreviewPorts, quantityPreviewSource, type QuantityPreviewMode } from "../../../lib/inventory/quantityPlanning/previewFixtures";
import { SnapshotStore } from "../domain/snapshot";
import { StaffApp, type StaffAppPorts } from "../ui/StaffApp";
import { photoPreviewImage, previewItems } from "./fixture";

const mode = (typeof window === "undefined" ? "registered" : new URLSearchParams(window.location.search).get("fixture") ?? "registered") as QuantityPreviewMode;
const source = quantityPreviewSource(mode);
const first = {
  ...previewItems[0], id: source.inventoryId, name: source.title, quantity: source.quantity ?? 0,
  plannedSalePrice: source.plannedUnitPriceYen, thumbnailUrl: photoPreviewImage("在庫の見本", "#94734f"),
};
const data = new Map<string, string>();
const storage = {
  getItem: (key: string) => typeof localStorage === "undefined" ? data.get(key) ?? null : localStorage.getItem(key),
  setItem: (key: string, value: string) => {
    if (typeof localStorage === "undefined") data.set(key, value);
    else localStorage.setItem(key, value);
  },
};
const snapshot = new SnapshotStore({
  getItem: async key => data.get(key) ?? null,
  setItem: async (key, value) => { data.set(key, value); },
  removeItem: async key => { data.delete(key); },
}, "quantity-preview", "fixture");

const ports: StaffAppPorts = {
  snapshot, online: async () => true,
  newMutationId: () => globalThis.crypto.randomUUID(),
  loadInventory: async () => [first],
  loadDetail: async () => first,
  save: async () => { throw new Error("画面確認用のデータです。"); },
  quantityPlanning: quantityPreviewPorts(mode, storage),
};

export function NativeQuantityPreview() {
  return <SafeAreaProvider><StaffApp ports={ports} offline={false} preview writesEnabled={mode !== "viewer"}
    features={{ sales: true, ecListing: false }} /></SafeAreaProvider>;
}

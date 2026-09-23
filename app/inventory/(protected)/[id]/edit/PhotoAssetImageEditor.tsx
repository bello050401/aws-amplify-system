"use client";

import { useState } from "react";
import { setPhotoAssetInventoryTypeAction, setPhotoAssetPrimaryAction } from "@/app/actions/photoRegistration";
import type { WebPhotoAssetView } from "@/lib/photoRegistration/webAdapter";

export function PhotoAssetImageEditor({ assets: initialAssets }: { assets: WebPhotoAssetView[] }) {
  const [assets, setAssets] = useState(initialAssets.map((asset) => ({ ...asset, inventoryImageType: asset.inventoryImageType === "DAMAGE" ? "DAMAGE" as const : "NORMAL" as const })));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (assets.length === 0) return null;

  async function setType(asset: WebPhotoAssetView, type: "NORMAL" | "DAMAGE") {
    if (pendingId) return;
    setPendingId(asset.id); setError(null);
    const result = await setPhotoAssetInventoryTypeAction({ photoBatchId: asset.photoBatchId, photoAssetId: asset.id, sequence: asset.sequence, type });
    setPendingId(null);
    if (!result.ok) return setError(result.message);
    setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, inventoryImageType: type } : item));
  }

  async function setPrimary(asset: WebPhotoAssetView) {
    if (pendingId || asset.inventoryIsPrimary) return;
    const previous = assets.find((item) => item.inventoryImageType !== "DAMAGE" && item.inventoryIsPrimary);
    setPendingId(asset.id); setError(null);
    const result = await setPhotoAssetPrimaryAction({
      selected: { photoBatchId: asset.photoBatchId, photoAssetId: asset.id, sequence: asset.sequence },
      previous: previous ? { photoBatchId: previous.photoBatchId, photoAssetId: previous.id, sequence: previous.sequence } : undefined,
    });
    setPendingId(null);
    if (!result.ok) return setError(result.message);
    setAssets((current) => current.map((item) => ({ ...item, inventoryIsPrimary: item.id === asset.id })));
  }

  const renderGroup = (type: "NORMAL" | "DAMAGE", title: string) => {
    const group = assets.filter((asset) => asset.inventoryImageType === type);
    return (
      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[11px] font-bold text-gray-500">{title}</p>
        {group.length === 0 ? <p className="text-xs text-gray-400">選択されていません</p> : (
          <div className="grid grid-cols-2 gap-2">
            {group.map((asset) => (
              <div key={asset.id} className="rounded border border-gray-200 bg-white p-1.5">
                {/* 署名付きS3 URLのホストは環境ごとに異なる。 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt={`撮影画像 ${asset.sequence + 1}`} className="aspect-square w-full bg-gray-50 object-contain" /> : <div className="aspect-square bg-gray-100" />}
                {type === "NORMAL" ? (
                  <button type="button" disabled={pendingId === asset.id || asset.inventoryIsPrimary} onClick={() => setPrimary(asset)}
                    className="mt-1 min-h-7 w-full border border-blue-300 px-1 text-[10px] text-blue-700 hover:bg-blue-50 disabled:bg-blue-50 disabled:font-bold disabled:opacity-100">
                    {asset.inventoryIsPrimary ? "トップ画像" : "トップ画像に設定"}
                  </button>
                ) : null}
                <button type="button" disabled={pendingId === asset.id} onClick={() => setType(asset, type === "NORMAL" ? "DAMAGE" : "NORMAL")}
                  className="mt-1 min-h-7 w-full border border-gray-300 px-1 text-[10px] hover:bg-gray-50 disabled:opacity-50">
                  {pendingId === asset.id ? "変更中…" : type === "NORMAL" ? "傷写真にする" : "商品画像に戻す"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return <>
    {renderGroup("NORMAL", "商品画像（撮影画像）")}
    {renderGroup("DAMAGE", "傷・汚れ写真（撮影画像から選択）")}
    {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
  </>;
}

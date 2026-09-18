"use client";

import { useState } from "react";
import { setPhotoAssetInventoryTypeAction } from "@/app/actions/photoRegistration";
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

  const renderGroup = (type: "NORMAL" | "DAMAGE", title: string) => {
    const group = assets.filter((asset) => asset.inventoryImageType === type);
    return (
      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[11px] font-bold text-gray-500">{title}</p>
        {group.length === 0 ? <p className="text-xs text-gray-400">選択されていません</p> : (
          <div className="grid grid-cols-2 gap-2">
            {group.map((asset) => (
              <div key={asset.id} className="rounded border border-gray-200 bg-white p-1.5">
                {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt={`撮影画像 ${asset.sequence + 1}`} className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-gray-100" />}
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

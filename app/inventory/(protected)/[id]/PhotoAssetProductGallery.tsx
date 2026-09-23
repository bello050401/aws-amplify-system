"use client";

import { useState } from "react";
import { listInventoryPhotoAssetsAction } from "@/app/actions/photoRegistration";
import type { WebPhotoAssetView } from "@/lib/photoRegistration/webAdapter";

export function PhotoAssetProductGallery({
  inventoryId,
  initialAssets,
  title = "商品画像（撮影画像）",
}: {
  inventoryId: string;
  initialAssets: WebPhotoAssetView[];
  title?: string;
}) {
  const [assets, setAssets] = useState(initialAssets);
  const [selected, setSelected] = useState(0);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (assets.length === 0) return null;
  const current = assets[Math.min(selected, assets.length - 1)];

  async function retry() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await listInventoryPhotoAssetsAction(inventoryId);
      if (result.ok) {
        setAssets(result.value.assets);
        setFailed(false);
      }
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="mt-6">
      <p className="mb-2 text-[11px] font-bold text-gray-400">{title}</p>
      <div className="flex h-[380px] w-full items-center justify-center border border-gray-200 bg-gray-50">
        {failed || !current.processedUrl ? (
          <div className="text-center text-[12px] text-gray-500">
            <p>画像を表示できませんでした（署名URLの期限切れの可能性があります）</p>
            <button
              type="button"
              onClick={retry}
              disabled={refreshing}
              className="mt-2 border border-gray-300 px-2 py-1 text-[11px] hover:bg-gray-100 disabled:opacity-50"
            >
              {refreshing ? "再取得中…" : "再取得"}
            </button>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- 署名済みS3 URL(photo registration用バケット)
          <img
            src={current.processedUrl}
            alt={`撮影画像 ${current.sequence}`}
            onError={() => setFailed(true)}
            className="h-[380px] w-full object-contain"
          />
        )}
      </div>

      {assets.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {assets.map((asset, i) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => {
                setSelected(i);
                setFailed(false);
              }}
              aria-label={`撮影画像 ${asset.sequence}を表示`}
              className={i === selected ? "ring-2 ring-gray-900" : "opacity-80 hover:opacity-100"}
            >
              {asset.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- 署名済みS3 URL(photo registration用バケット)
                <img
                  src={asset.thumbnailUrl}
                  alt={`撮影画像 ${asset.sequence}`}
                  className="h-[60px] w-[60px] border border-gray-200 bg-gray-50 object-contain"
                />
              ) : (
                <div className="h-[60px] w-[60px] border border-gray-200 bg-gray-100" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

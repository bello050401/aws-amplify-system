"use client";

import { useEffect, useState } from "react";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { WebPhotoAssetView } from "@/lib/photoRegistration/webAdapter";
import type { ListingImageRef } from "@/lib/listing/types";
import {
  buildListingImageCandidates,
  restoreListingSelection,
  listingRefsFromSelection,
  initialListingSelection,
  type ListingImageCandidate,
} from "@/lib/photoRegistration/inventoryListingAdapter";
import { InventoryThumbnail } from "../../../InventoryThumbnail";

const MAX_SELECTION = 20;

function candidateKey(candidate: ListingImageCandidate): string {
  return candidate.ref.photoAssetId ?? candidate.ref.storageKey;
}

export function ListingImageSelector({
  images,
  photoAssets,
  initialImages,
  brandedImageKey,
  onChange,
}: {
  images: InventoryImageRecord[];
  photoAssets: WebPhotoAssetView[];
  initialImages: ListingImageRef[] | null;
  brandedImageKey?: string | null;
  onChange: (refs: ListingImageRef[]) => void;
}) {
  const candidates = buildListingImageCandidates(images, photoAssets);
  for (const ref of initialImages ?? []) {
    if (ref.storageKey.startsWith("inventory/listing-branded/") && !candidates.some((item) => item.ref.storageKey === ref.storageKey)) {
      candidates.push({ ref, label: "保存済みロゴ入り画像", previewUrl: null, available: true });
    }
  }
  if (brandedImageKey && !candidates.some((item) => item.ref.storageKey === brandedImageKey)) {
    candidates.push({ ref: { storageKey: brandedImageKey, sortOrder: 0, source: "INVENTORY" }, label: "ロゴ入り画像", previewUrl: null, available: true });
  }

  const [selected, setSelected] = useState<ListingImageCandidate[]>(() => {
    return initialListingSelection(candidates, initialImages);
  });
  const [missingCount] = useState<number>(() =>
    initialImages && initialImages.length > 0 ? restoreListingSelection(candidates, initialImages).missing.length : 0,
  );

  const selectedKeys = new Set(selected.map(candidateKey));
  const available = candidates.filter((c) => !selectedKeys.has(candidateKey(c)));

  useEffect(() => {
    onChange(listingRefsFromSelection(selected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    if (!brandedImageKey) return;
    setSelected((current) => {
      const branded = candidates.find((item) => item.ref.storageKey === brandedImageKey);
      if (!branded) return current;
      if (current.length >= MAX_SELECTION && !current.some((item) => item.ref.storageKey === brandedImageKey)) return current;
      return [branded, ...current.filter((item) => item.ref.storageKey !== brandedImageKey)];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandedImageKey]);

  function addCandidate(candidate: ListingImageCandidate) {
    if (selected.length >= MAX_SELECTION) return;
    setSelected((prev) => [...prev, candidate]);
  }
  function removeCandidate(candidate: ListingImageCandidate) {
    setSelected((prev) => prev.filter((c) => candidateKey(c) !== candidateKey(candidate)));
  }
  function moveUp(index: number) {
    if (index <= 0) return;
    setSelected((prev) => {
      const next = prev.slice();
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }
  function moveDown(index: number) {
    setSelected((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = prev.slice();
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
  }
  function makePrimary(index: number) {
    if (index <= 0) return;
    setSelected((prev) => {
      const next = prev.slice();
      const [item] = next.splice(index, 1);
      next.unshift(item);
      return next;
    });
  }

  function thumbnailFor(candidate: ListingImageCandidate) {
    if (candidate.ref.source === "PHOTO_ASSET") {
      return candidate.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- 署名済みS3 URL(photo registration用バケット)
        <img src={candidate.previewUrl} alt={candidate.label} className="h-[60px] w-[60px] shrink-0 border border-gray-200 object-cover" />
      ) : (
        <div className="flex h-[60px] w-[60px] shrink-0 items-center justify-center border border-gray-200 bg-gray-50 text-[9px] text-gray-400">
          No Image
        </div>
      );
    }
    return <InventoryThumbnail storageKey={candidate.ref.storageKey} alt={candidate.label} size="medium" />;
  }

  return (
    <div className="mt-4 border border-gray-200 p-3">
      <p className="mb-2 text-[12px] font-bold text-gray-700">出品画像（並び順のままMercari Shopsへ渡します。先頭が主画像）</p>
      {missingCount > 0 && (
        <p className="mb-2 text-[11px] text-amber-700">
          {missingCount}件の保存済み画像を復元できませんでした（削除済みの可能性があります）。
        </p>
      )}
      {selected.length === 0 ? (
        <p className="text-[11px] text-amber-700">出品画像が選択されていません。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {selected.map((candidate, index) => (
            <li key={candidateKey(candidate)} className="flex items-center gap-2 border border-gray-100 p-1">
              {thumbnailFor(candidate)}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-gray-600">{candidate.label}</p>
                {index === 0 && <p className="text-[10px] font-bold text-blue-700">主画像</p>}
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={() => moveUp(index)} disabled={index === 0} className="border border-gray-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30">
                  ↑
                </button>
                <button type="button" onClick={() => moveDown(index)} disabled={index === selected.length - 1} className="border border-gray-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30">
                  ↓
                </button>
                {index !== 0 && (
                  <button type="button" onClick={() => makePrimary(index)} className="border border-gray-300 px-1.5 py-0.5 text-[11px]">
                    主画像にする
                  </button>
                )}
                <button type="button" onClick={() => removeCandidate(candidate)} className="border border-gray-300 px-1.5 py-0.5 text-[11px] text-red-600">
                  外す
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-bold text-gray-500">候補（クリックで追加）</p>
          <div className="flex flex-wrap gap-1">
            {available.map((candidate) => (
              <button
                key={candidateKey(candidate)}
                type="button"
                onClick={() => addCandidate(candidate)}
                disabled={selected.length >= MAX_SELECTION}
                title={candidate.label}
                className="opacity-80 hover:opacity-100 disabled:opacity-30"
              >
                {thumbnailFor(candidate)}
              </button>
            ))}
          </div>
        </div>
      )}
      {selected.length >= MAX_SELECTION && <p className="mt-1 text-[10px] text-gray-400">出品画像は最大{MAX_SELECTION}枚までです。</p>}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { getInventoryService } from "@/lib/api";
import { compressImageForUpload, isSupportedImageFile, MAX_IMAGES_PER_ITEM } from "@/lib/utils/image";
import { toErrorMessage } from "./ErrorState";
import { InlineSpinner } from "./LoadingOverlay";

interface UploadedImage {
  key: string;
  url: string;
  uploading?: boolean;
  error?: string;
}

/**
 * サムネイル画像・追加画像(最大10枚)のアップロードUI(指示書 §9-3, §27, §29)。
 * 編集画面・新規登録画面で共通利用する。
 *
 * 新規登録時はitemIdがまだDB上に存在しないため、呼び出し側で
 * crypto.randomUUID() 等で先に採番したIDを渡し、保存時に同じIDでItemを
 * 作成することで画像と在庫IDの紐付けを維持する(指示書 §27)。
 */
export function ImageUploader({
  itemId,
  thumbnailKey,
  imageKeys,
  onThumbnailChange,
  onImagesChange,
}: {
  itemId: string;
  thumbnailKey: string | null | undefined;
  imageKeys: string[];
  onThumbnailChange: (key: string | null) => void;
  onImagesChange: (keys: string[]) => void;
}) {
  const service = getInventoryService();
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [thumbUrl, setThumbUrl] = useState<string>("");
  const [images, setImages] = useState<UploadedImage[]>([]);

  useEffect(() => {
    let active = true;
    if (thumbnailKey) {
      service.getImageUrl(thumbnailKey).then((url) => active && setThumbUrl(url));
    } else {
      setThumbUrl("");
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnailKey]);

  useEffect(() => {
    let active = true;
    Promise.all(
      imageKeys.map(async (key) => ({ key, url: await service.getImageUrl(key) }))
    ).then((resolved) => active && setImages(resolved));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKeys.join(",")]);

  async function handleThumbnailSelect(file: File | undefined) {
    if (!file) return;
    if (!isSupportedImageFile(file)) return;
    try {
      const compressed = await compressImageForUpload(file);
      const key = await service.uploadImage(itemId, compressed);
      onThumbnailChange(key);
    } catch (e) {
      alert(`サムネイルのアップロードに失敗しました: ${toErrorMessage(e)}`);
    }
  }

  async function handleGallerySelect(fileList: FileList | null) {
    if (!fileList) return;
    const files = Array.from(fileList).slice(0, MAX_IMAGES_PER_ITEM - imageKeys.length);
    for (const file of files) {
      if (!isSupportedImageFile(file)) continue;
      const tempUrl = URL.createObjectURL(file);
      setImages((prev) => [...prev, { key: tempUrl, url: tempUrl, uploading: true }]);
      try {
        const compressed = await compressImageForUpload(file);
        const key = await service.uploadImage(itemId, compressed);
        const url = await service.getImageUrl(key);
        setImages((prev) => prev.map((img) => (img.key === tempUrl ? { key, url } : img)));
        onImagesChange([...imageKeys, key]);
      } catch (e) {
        setImages((prev) =>
          prev.map((img) => (img.key === tempUrl ? { ...img, uploading: false, error: toErrorMessage(e) } : img))
        );
      }
    }
  }

  function removeImage(key: string) {
    onImagesChange(imageKeys.filter((k) => k !== key));
    setImages((prev) => prev.filter((img) => img.key !== key));
  }

  function moveImage(key: string, dir: -1 | 1) {
    const idx = imageKeys.indexOf(key);
    const target = idx + dir;
    if (idx === -1 || target < 0 || target >= imageKeys.length) return;
    const next = [...imageKeys];
    [next[idx], next[target]] = [next[target], next[idx]];
    onImagesChange(next);
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-1 block text-sm font-medium text-bello-700">サムネイル画像</span>
        <button
          onClick={() => thumbInputRef.current?.click()}
          className="tap-target relative flex h-28 w-28 items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-bello-200 bg-bello-50"
        >
          {thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbUrl} alt="サムネイル" className="h-full w-full object-cover" />
          ) : (
            <span className="text-3xl text-bello-300">＋</span>
          )}
        </button>
        <input
          ref={thumbInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleThumbnailSelect(e.target.files?.[0])}
        />
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-sm font-medium text-bello-700">その他画像・ファイル</span>
          <span className="text-xs text-bello-400">
            {imageKeys.length} / {MAX_IMAGES_PER_ITEM}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {images.map((img) => (
            <div key={img.key} className="relative h-20 w-20 overflow-hidden rounded-xl bg-bello-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="h-full w-full object-cover" />
              {img.uploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <InlineSpinner />
                </div>
              )}
              {img.error && (
                <div className="absolute inset-0 flex items-center justify-center bg-danger-500/80 text-[10px] text-white">
                  失敗
                </div>
              )}
              {!img.uploading && (
                <button
                  onClick={() => removeImage(img.key)}
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white"
                  aria-label="削除"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {imageKeys.length < MAX_IMAGES_PER_ITEM && (
            <button
              onClick={() => galleryInputRef.current?.click()}
              className="tap-target flex h-20 w-20 items-center justify-center rounded-xl border-2 border-dashed border-bello-200 bg-bello-50 text-2xl text-bello-300"
            >
              ＋
            </button>
          )}
        </div>
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          multiple
          capture="environment"
          className="hidden"
          onChange={(e) => handleGallerySelect(e.target.files)}
        />
      </div>
    </div>
  );
}

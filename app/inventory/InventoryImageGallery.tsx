"use client";

import { useEffect, useState } from "react";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { useInventoryImageUrl } from "./useInventoryImageUrl";
import { InventoryThumbnail } from "./InventoryThumbnail";

interface InventoryImageGalleryProps {
  images: { storageKey: string; sortOrder: number }[];
  alt: string;
}

/**
 * Detail-page image display (spec §2/§3): a large main image (≈5x the
 * old thumbnail's area — big enough to actually check a furniture item's
 * condition) with the rest as a clickable thumbnail strip, and a click on
 * the main image opens a simple lightbox at as close to full resolution
 * as the viewport allows. No animation, no library — a plain fixed
 * overlay is exactly what spec asks for ("簡素なライトボックス形式で構
 * わない"). Esc closes it; ←/→ move between images when there's more
 * than one.
 */
export function InventoryImageGallery({ images, alt }: InventoryImageGalleryProps) {
  const [selected, setSelected] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const current = images[selected] as { storageKey: string } | undefined;
  const { url, failed } = useInventoryImageUrl(current?.storageKey ?? null);

  useEffect(() => {
    if (!lightboxOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxOpen(false);
      if (e.key === "ArrowRight") setSelected((i) => Math.min(i + 1, images.length - 1));
      if (e.key === "ArrowLeft") setSelected((i) => Math.max(i - 1, 0));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen, images.length]);

  if (images.length === 0) {
    return <InventoryThumbnail storageKey={null} alt={alt} size="hero" />;
  }

  return (
    <div>
      <ConfigureAmplifyClientSide />
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="block w-full cursor-zoom-in border border-gray-200 bg-gray-50"
        aria-label="画像を拡大表示"
      >
        {failed || !url ? (
          <InventoryThumbnail storageKey={current?.storageKey ?? null} alt={alt} size="hero" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- S3 URL; see InventoryThumbnail's identical note.
          <img src={url} alt={alt} className="h-[380px] w-full object-contain" />
        )}
      </button>

      {images.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {images.map((img, i) => (
            <button
              key={img.storageKey}
              type="button"
              onClick={() => setSelected(i)}
              aria-label={`${i + 1}枚目を表示`}
              className={i === selected ? "ring-2 ring-gray-900" : "opacity-80 hover:opacity-100"}
            >
              <InventoryThumbnail storageKey={img.storageKey} alt={`${alt} ${i + 1}`} size="medium" />
            </button>
          ))}
        </div>
      )}

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            aria-label="閉じる"
            className="absolute right-4 top-4 text-2xl leading-none text-white hover:text-gray-300"
          >
            ×
          </button>
          {images.length > 1 && selected > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSelected((i) => i - 1);
              }}
              aria-label="前の画像"
              className="absolute left-4 text-3xl leading-none text-white hover:text-gray-300"
            >
              ‹
            </button>
          )}
          {url && (
            // eslint-disable-next-line @next/next/no-img-element -- S3 URL; see InventoryThumbnail's identical note.
            <img src={url} alt={alt} onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full object-contain" />
          )}
          {images.length > 1 && selected < images.length - 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSelected((i) => i + 1);
              }}
              aria-label="次の画像"
              className="absolute right-4 text-3xl leading-none text-white hover:text-gray-300"
            >
              ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}

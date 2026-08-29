"use client";

import { useEffect, useState } from "react";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { useInventoryImageUrl } from "./useInventoryImageUrl";
import { InventoryThumbnail } from "./InventoryThumbnail";

interface InventoryImageGalleryProps {
  images: { storageKey: string; sortOrder: number }[];
  alt: string;
  /** Section heading rendered above the gallery (Phase C.5: "商品画像" / "傷・汚れ写真" — see the detail page). Omit to render with no heading, matching the original single-gallery layout. */
  title?: string;
  /** When true and `images` is empty, renders nothing at all rather than the "No Image" hero placeholder — used for the 傷・汚れ写真 group, where having none at all is the common case and a big empty placeholder box would just be clutter (spec §6/§11: don't over-build this screen). The 商品画像 group keeps the placeholder (hideIfEmpty defaults false) since every Inventory item is expected to have at least a representative photo. */
  hideIfEmpty?: boolean;
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
 *
 * Phase C.5: rendered twice on the detail page — once for 商品画像
 * (normal), once for 傷・汚れ写真 (damage) — the exact same component
 * and lightbox both times (spec §11: "lightboxも両方で利用可能な構造")
 * rather than a second implementation. The caller is expected to have
 * already put the resolved top image first in `images` for the normal
 * group (see lib/inventory/imageTypes.ts's resolveTopImage) — this
 * component itself has no opinion on which image is "the" top one, it
 * just always shows whichever is first.
 */
export function InventoryImageGallery({ images, alt, title, hideIfEmpty = false }: InventoryImageGalleryProps) {
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
    if (hideIfEmpty) return null;
    return (
      <div>
        {title && <p className="mb-2 text-[11px] font-bold text-gray-400">{title}</p>}
        <InventoryThumbnail storageKey={null} alt={alt} size="hero" loading="eager" />
      </div>
    );
  }

  return (
    <div>
      <ConfigureAmplifyClientSide />
      {title && <p className="mb-2 text-[11px] font-bold text-gray-400">{title}</p>}
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="block w-full cursor-zoom-in border border-gray-200 bg-gray-50"
        aria-label="画像を拡大表示"
      >
        {failed || !url ? (
          <InventoryThumbnail storageKey={current?.storageKey ?? null} alt={alt} size="hero" loading="eager" />
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

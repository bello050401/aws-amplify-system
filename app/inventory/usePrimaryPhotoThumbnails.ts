"use client";

import { useEffect, useState } from "react";
import { readPhotoPreview } from "@/lib/photoRegistration/previewClient";
import type { PhotoThumbnailChoice } from "@/lib/photoRegistration/gallerySelection";

/** Load only the visible page, progressively. Text and inventory thumbnails
 * remain available while Photo Station resolves signed thumbnail URLs. */
export function usePrimaryPhotoThumbnails(inventoryIds: string[], enabled = true) {
  // The caller may paginate into a fresh array on each render. Key by IDs to
  // avoid repeatedly restarting the request when its own results arrive.
  const pageKey = inventoryIds.join("\u0000");
  const [result, setResult] = useState<{ key: string; photos: Record<string, PhotoThumbnailChoice> } | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const ids = pageKey ? pageKey.split("\u0000") : [];
    void (async () => {
      let photos: Record<string, PhotoThumbnailChoice> = {};
      for (let start = 0; active && enabled && start < ids.length; start += 100) {
        try {
          const response = await readPhotoPreview<Record<string, PhotoThumbnailChoice>>(
            new URLSearchParams({ids: ids.slice(start, start + 100).join(',')}), controller.signal);
          if (active && !controller.signal.aborted) {
            photos = { ...photos, ...response };
            setResult({ key: pageKey, photos });
          }
        } catch { break; /* Keep the existing inventory thumbnail on lookup failure. */ }
      }
      clearTimeout(timeout);
    })();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [pageKey, enabled]);
  return enabled && result?.key === pageKey ? result.photos : {};
}

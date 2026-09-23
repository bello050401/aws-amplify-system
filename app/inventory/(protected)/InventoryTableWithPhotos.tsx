"use client";

import { useEffect, useMemo, useState } from "react";
import { listInventoryPrimaryPhotoThumbnailsAction } from "@/app/actions/photoRegistration";
import { InventoryTable } from "./InventoryTable";
import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<typeof InventoryTable>, "photoThumbnails"> & { photoRegistrationEnabled: boolean };

/** Text and existing inventory thumbnails render immediately. The optional Photo
 * Registration lookup can be slow for 100 rows, so it runs after first paint.
 * Ignore an older page's response when search/pagination changes mid-request. */
export function InventoryTableWithPhotos({ photoRegistrationEnabled, ...props }: Props) {
  const ids = useMemo(() => props.rows.map((row) => row.id), [props.rows]);
  const pageKey = ids.join("\u0000");
  const [result, setResult] = useState<{ key: string; photos: Record<string, string | null> } | null>(null);
  useEffect(() => {
    let active = true;
    // Resolve the first rows first. Waiting for the slowest of 100 products
    // before showing any Photo Station image made the visible rows feel stuck.
    // Later chunks fill in progressively and retain the inventory thumbnail as
    // fallback throughout.
    void (async () => {
      const chunkSize = 16;
      let photos: Record<string, string | null> = {};
      for (let start = 0; active && photoRegistrationEnabled && start < ids.length; start += chunkSize) {
        try {
          const response = await listInventoryPrimaryPhotoThumbnailsAction(ids.slice(start, start + chunkSize));
          if (active && response.ok) {
            photos = { ...photos, ...response.value };
            setResult({ key: pageKey, photos });
          }
        } catch { /* The inventory thumbnails remain available. */ }
      }
    })();
    return () => { active = false; };
  }, [ids, pageKey, photoRegistrationEnabled]);
  return <InventoryTable {...props} photoThumbnails={result?.key === pageKey ? result.photos : {}} />;
}

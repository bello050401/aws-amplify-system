"use client";

import { useEffect, useState } from "react";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { useInventoryImageUrl } from "./useInventoryImageUrl";

const SIZE_CLASSES = {
  small: "h-10 w-10", // was the only size; kept for anywhere not yet migrated
  medium: "h-[60px] w-[60px]", // list table thumbnail (spec: ~1.5x of the old 40px) and the detail gallery's thumbnail strip
  large: "h-20 w-full", // unused after the detail-page gallery rework, kept for any other small-preview use (e.g. ImageEditor slots)
  hero: "h-[380px] w-full", // detail page main image / no-image fallback
} as const;

/**
 * Resolves an `inventory/*` Storage key to a viewable URL client-side, one
 * request per distinct key (via useInventoryImageUrl — see that file for
 * the retry rationale). Storage access is Cognito-group scoped (see
 * amplify/storage/resource.ts) — no public/guest rule — so this only
 * works for a signed-in ADMIN/EDITOR/VIEWER, which is exactly who ever
 * reaches this component (it only renders inside the (protected) route
 * group).
 */
export function InventoryThumbnail({
  storageKey,
  alt,
  size = "small",
}: {
  storageKey: string | null;
  alt: string;
  size?: keyof typeof SIZE_CLASSES;
}) {
  const { url, failed: resolveFailed } = useInventoryImageUrl(storageKey);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [storageKey]);
  const failed = resolveFailed || loadFailed;

  if (!storageKey || failed) {
    return (
      <div className={`flex ${SIZE_CLASSES[size]} shrink-0 items-center justify-center border border-gray-200 bg-gray-50 text-[9px] text-gray-400`}>
        <ConfigureAmplifyClientSide />
        No Image
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- S3 URL, arbitrary/rotating host; next/image would need remotePatterns for a bucket domain that doesn't exist until deploy.
    <img
      src={url ?? undefined}
      alt={alt}
      onError={(e) => {
        // getUrl() succeeded (a valid presigned URL) but the browser
        // still couldn't load it — e.g. the object doesn't actually
        // exist at that key. Falls back to the same placeholder instead
        // of leaving a permanently broken-image icon.
        console.error(`[InventoryThumbnail] image failed to load for "${storageKey}":`, e);
        setLoadFailed(true);
      }}
      className={`${SIZE_CLASSES[size]} shrink-0 border border-gray-200 object-cover bg-gray-50`}
    />
  );
}

"use client";

import { useEffect, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";

/**
 * Resolves an `inventory/*` Storage key to a viewable URL client-side, one
 * request per distinct key. Storage access is Cognito-group scoped (see
 * amplify/storage/resource.ts) — no public/guest rule — so this only
 * works for a signed-in ADMIN/EDITOR/VIEWER, which is exactly who ever
 * reaches this component (it only renders inside the (protected) route
 * group). Doing this client-side, one thumbnail at a time, rather than
 * resolving all URLs server-side per list request, keeps the list page's
 * own render off the Storage round-trip entirely.
 */
export function InventoryThumbnail({ storageKey, alt }: { storageKey: string | null; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!storageKey) return;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    getUrl({ path: storageKey })
      .then(({ url }) => {
        if (!cancelled) setUrl(url.toString());
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  if (!storageKey || failed) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-gray-200 bg-gray-50 text-[9px] text-gray-400">
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
      className="h-10 w-10 shrink-0 border border-gray-200 object-cover bg-gray-50"
    />
  );
}

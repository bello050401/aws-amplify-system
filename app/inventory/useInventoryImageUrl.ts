"use client";

import { useEffect, useState } from "react";
import { getUrl } from "aws-amplify/storage";

const RETRY_DELAYS_MS = [400, 1200]; // total ≤3 attempts

/**
 * Resolves an `inventory/*` Storage key to a viewable URL client-side.
 * Extracted out of InventoryThumbnail once the detail page's image
 * gallery (InventoryImageGallery.tsx) needed the same resolution logic
 * for its large hero/lightbox view, not just small thumbnails.
 *
 * Retries a couple of times on failure rather than giving up after one
 * rejection: `getUrl()` needs the Identity Pool credentials behind the
 * signed-in user's Cognito session, and on a fresh page load those can
 * still be mid-restoration when the first attempt fires. A genuine
 * permission/missing-object problem still ends in `failed: true` once
 * retries are exhausted and logs the real error — this only smooths over
 * that startup race.
 */
export function useInventoryImageUrl(storageKey: string | null): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!storageKey) {
      setUrl(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setFailed(false);

    const attempt = (retriesLeft: number) => {
      getUrl({ path: storageKey })
        .then(({ url }) => {
          if (!cancelled) setUrl(url.toString());
        })
        .catch((err) => {
          if (cancelled) return;
          if (retriesLeft > 0) {
            const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - retriesLeft] ?? 1200;
            setTimeout(() => !cancelled && attempt(retriesLeft - 1), delay);
            return;
          }
          console.error(`[useInventoryImageUrl] getUrl failed for "${storageKey}" after retries:`, err);
          setFailed(true);
        });
    };
    attempt(RETRY_DELAYS_MS.length);

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  return { url, failed };
}

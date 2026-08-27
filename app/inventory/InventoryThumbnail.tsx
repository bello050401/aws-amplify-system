"use client";

import { useEffect, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";

const RETRY_DELAYS_MS = [400, 1200]; // total ≤3 attempts

/**
 * Resolves an `inventory/*` Storage key to a viewable URL client-side, one
 * request per distinct key. Storage access is Cognito-group scoped (see
 * amplify/storage/resource.ts) — no public/guest rule — so this only
 * works for a signed-in ADMIN/EDITOR/VIEWER, which is exactly who ever
 * reaches this component (it only renders inside the (protected) route
 * group). Doing this client-side, one thumbnail at a time, rather than
 * resolving all URLs server-side per list request, keeps the list page's
 * own render off the Storage round-trip entirely.
 *
 * Retries a couple of times on failure rather than giving up after one
 * rejection: `getUrl()` needs the Identity Pool credentials behind the
 * signed-in user's Cognito session, and on a fresh page load (right after
 * registering, or a hard refresh) Amplify's client-side session
 * restoration can still be in flight when this effect's first attempt
 * fires — that attempt gets treated as unauthenticated (no guest rule
 * exists on this path, so it's denied) even though the user genuinely
 * has access, and normally resolves on retry a moment later. A real
 * permission/missing-object problem still ends in "No Image" once
 * retries are exhausted — this only smooths over the startup race.
 */
export function InventoryThumbnail({ storageKey, alt }: { storageKey: string | null; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!storageKey) return;
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
          // Logged, not swallowed — this is exactly the signal needed to
          // tell "transient session-restore race" apart from "genuine
          // Storage access/permission problem" the next time this comes up.
          console.error(`[InventoryThumbnail] getUrl failed for "${storageKey}" after retries:`, err);
          setFailed(true);
        });
    };
    attempt(RETRY_DELAYS_MS.length);

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
      onError={(e) => {
        // getUrl() succeeded (a valid presigned URL) but the browser
        // still couldn't load it — e.g. the object doesn't actually
        // exist at that key. Falls back to the same placeholder instead
        // of leaving a permanently broken-image icon.
        console.error(`[InventoryThumbnail] image failed to load for "${storageKey}":`, e);
        setFailed(true);
      }}
      className="h-10 w-10 shrink-0 border border-gray-200 object-cover bg-gray-50"
    />
  );
}

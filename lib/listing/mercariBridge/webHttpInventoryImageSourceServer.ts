import "server-only";

import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { getInventoryDetail } from "@/lib/inventory/queries";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { prepareInventoryImageForObservedUpload } from
  "./webHttpInventoryImageSource.ts";

/** Same signed BELLO-storage read path as inventory thumbnails. The cap is
 * enforced while streaming, before buffering more than one image.
 */
async function readOwnStorageBytes(storageKey: string,
  maxBytes: number): Promise<Uint8Array | null> {
  const { url } = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: contextSpec => getUrl(contextSpec, { path: storageKey }),
  });
  const response = await fetch(url, { cache: "no-store",
    redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) return null;
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Production BELLO source adapter. It deliberately has no Shops transport. */
export function prepareBelloInventoryImageForObservedUpload(
  job: WebHttpDraftJob,
) {
  return prepareInventoryImageForObservedUpload(job, {
    readInventory: getInventoryDetail,
    readStorageBytes: readOwnStorageBytes,
  });
}

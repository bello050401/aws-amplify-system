import "server-only";
import outputs from "@/amplify_outputs.json";
import { SystemErrorQueue, errorQueueConfig } from "./queue";
import { normalizeSystemErrorSignal, type SystemErrorSignal } from "./contract";

export function getSystemErrorQueue(): SystemErrorQueue | null {
  const config = (outputs as {custom?: {systemErrors?: {tableName?: string; region?: string; release?: string}}}).custom?.systemErrors;
  const resolved = errorQueueConfig({...process.env,
    BELLO_SYSTEM_ERRORS_ENABLED: process.env.BELLO_SYSTEM_ERRORS_ENABLED || (config?.tableName ? "1" : "0"),
    BELLO_SYSTEM_ERRORS_TABLE: process.env.BELLO_SYSTEM_ERRORS_TABLE || config?.tableName,
    BELLO_SYSTEM_ERRORS_RELEASE: process.env.BELLO_SYSTEM_ERRORS_RELEASE || config?.release || "unknown",
    AWS_REGION: process.env.AWS_REGION || config?.region,
  });
  return resolved ? new SystemErrorQueue(resolved) : null;
}

/** For trusted server error hooks only. The signal still passes the same
 * allowlist. No request, headers, URL, message or stack is read here. */
export async function reportServerSystemError(signal: SystemErrorSignal): Promise<boolean> {
  try {
    const safe = normalizeSystemErrorSignal(signal), queue = getSystemErrorQueue();
    if (!safe || !queue) return false;
    return (await queue.enqueue(safe, "server-runtime")).accepted;
  } catch { return false; }
}

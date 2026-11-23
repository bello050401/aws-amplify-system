import "server-only";
import { SystemErrorQueue, errorQueueConfig } from "./queue";
import { normalizeSystemErrorSignal, type SystemErrorSignal } from "./contract";

export function getSystemErrorQueue(): SystemErrorQueue | null {
  // Runtime overrides stay dynamic even when Next inlines build-only defaults.
  // Shared Lambda imports must never depend on generated frontend outputs.
  const env = process.env;
  const resolved = errorQueueConfig({
    NODE_ENV: env.NODE_ENV,
    BELLO_SYSTEM_ERRORS_ENABLED: env.BELLO_SYSTEM_ERRORS_ENABLED || process.env.BELLO_SYSTEM_ERRORS_BUILD_ENABLED || "0",
    BELLO_SYSTEM_ERRORS_TABLE: env.BELLO_SYSTEM_ERRORS_TABLE || process.env.BELLO_SYSTEM_ERRORS_BUILD_TABLE,
    BELLO_SYSTEM_ERRORS_RELEASE: env.BELLO_SYSTEM_ERRORS_RELEASE || process.env.BELLO_SYSTEM_ERRORS_BUILD_RELEASE || "unknown",
    AWS_REGION: env.AWS_REGION || env.BELLO_SYSTEM_ERRORS_REGION || process.env.BELLO_SYSTEM_ERRORS_BUILD_REGION,
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

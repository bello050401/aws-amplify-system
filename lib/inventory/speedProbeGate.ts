import "server-only";

const APP_ID = "d4hkkg7dty2du";
const BRANCH = "claude/inventory-management-system-5vbvc7";
const MAX_WINDOW_MS = 48 * 60 * 60 * 1000;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export const SPEED_PROBE_INVENTORY_ID = "96150ede-950a-4316-b37b-be6815498d77";

type Environment = Record<string, string | undefined>;

/** Only the staging ADMIN pages render the explicit, short-lived QA control. */
export function inventorySpeedProbeEnabled(env: Environment = process.env, now = Date.now()): boolean {
  if (env.NODE_ENV !== "production" || env.INVENTORY_SPEED_PROBE_ENABLED !== "1" ||
      env.INVENTORY_SPEED_PROBE_APP_ID !== APP_ID || env.INVENTORY_SPEED_PROBE_BRANCH !== BRANCH) return false;
  const start = env.INVENTORY_SPEED_PROBE_START_AT ?? "";
  const end = env.INVENTORY_SPEED_PROBE_END_AT ?? "";
  if (!ISO_UTC.test(start) || !ISO_UTC.test(end)) return false;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) &&
    new Date(startMs).toISOString() === start && new Date(endMs).toISOString() === end &&
    endMs > startMs && endMs - startMs <= MAX_WINDOW_MS && now >= startMs && now < endMs;
}

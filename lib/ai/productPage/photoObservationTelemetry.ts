import "server-only";

const randomUUID = () => globalThis.crypto.randomUUID();

const PROCESS_SLOT = Symbol.for("bello.photo-cache.process.v1");
const STAGING_APP_ID = "d4hkkg7dty2du";
const STAGING_BRANCH = "claude/inventory-management-system-5vbvc7";
const MAX_WINDOW_MS = 48 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PhotoCacheRead = "not_attempted" | "hit" | "miss" | "invalid" | "error";
export type PhotoCacheWrite = "not_attempted" | "success" | "error";
export type PhotoCacheSource = "memory" | "inflight" | "persistent" | "vision" | "none";
export type PhotoCacheCompletion = "completed" | "failed";
export type PhotoCacheOperation = {
  markRead(value: Exclude<PhotoCacheRead, "not_attempted">): void;
  markWrite(value: Exclude<PhotoCacheWrite, "not_attempted">): void;
  markVisionCall(): void;
  finish(source: PhotoCacheSource, completion: PhotoCacheCompletion): void;
};
export type PhotoCacheTelemetry = { start(): PhotoCacheOperation | null };

type Config = { releaseTag: "A" | "B"; experimentId: string };
type ProcessState = { id: string; announced: boolean };
type Environment = Record<string, string | undefined>;
type Log = (event: string, fields: Record<string, string | number>) => void;
const defaultLog: Log = (event, fields) => console.info(`[${event}]`, JSON.stringify(fields));

function processState(): ProcessState {
  const slot = process as unknown as Record<symbol, ProcessState | undefined>;
  return slot[PROCESS_SLOT] ?? (slot[PROCESS_SLOT] = { id: randomUUID(), announced: false });
}

/** Staging only, opt-in, with a concrete start and expiry no more than 48 hours apart. */
export function photoCacheTelemetryConfig(env: Environment, now: number): Config | null {
  if (env.PHOTO_CACHE_TELEMETRY_ENABLED !== "1" || env.NODE_ENV !== "production" ||
      env.PHOTO_CACHE_TELEMETRY_APP_ID !== STAGING_APP_ID ||
      env.PHOTO_CACHE_TELEMETRY_BRANCH !== STAGING_BRANCH) return null;
  const releaseTag = env.PHOTO_CACHE_TELEMETRY_RELEASE_TAG;
  const experimentId = env.PHOTO_CACHE_TELEMETRY_EXPERIMENT_ID;
  const start = env.PHOTO_CACHE_TELEMETRY_START_AT;
  const end = env.PHOTO_CACHE_TELEMETRY_END_AT;
  if ((releaseTag !== "A" && releaseTag !== "B") || !experimentId || !UUID.test(experimentId) || !start || !end ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(start) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(end)) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) ||
      new Date(startMs).toISOString() !== start || new Date(endMs).toISOString() !== end ||
      endMs <= startMs ||
      endMs - startMs > MAX_WINDOW_MS || now < startMs || now >= endMs) return null;
  return { releaseTag, experimentId };
}

/** Logs only fixed enum values and random IDs; no request, cache key, model or SDK object enters Log. */
export function createPhotoCacheTelemetry(
  env: Environment = process.env,
  now: () => number = Date.now,
  log: Log = defaultLog,
): PhotoCacheTelemetry & { registerProcess(): void } {
  function enabled(): Config | null { return photoCacheTelemetryConfig(env, now()); }
  function safeLog(event: string, fields: Record<string, string | number>): void {
    try { log(event, fields); } catch { /* Telemetry never affects observation. */ }
  }
  function registerProcess(): void {
    const state = processState();
    const config = enabled();
    if (!config || state.announced) return;
    state.announced = true;
    safeLog("photo_cache_process_start", {
      process_id: state.id, release_tag: config.releaseTag, experiment_id: config.experimentId,
    });
  }
  function start(): PhotoCacheOperation | null {
    const config = enabled();
    if (!config) return null;
    registerProcess();
    const processId = processState().id;
    const operationId = randomUUID();
    let persistentRead: PhotoCacheRead = "not_attempted";
    let persistentWrite: PhotoCacheWrite = "not_attempted";
    let visionCalls = 0;
    let ended = false;
    safeLog("photo_cache_start", {
      process_id: processId, operation_id: operationId,
      release_tag: config.releaseTag, experiment_id: config.experimentId,
    });
    return {
      markRead(value) {
        if (persistentRead === "not_attempted" || value !== "miss") persistentRead = value;
      },
      markWrite(value) { persistentWrite = value; },
      markVisionCall() { visionCalls = 1; },
      finish(source, completion) {
        if (ended) return;
        ended = true;
        safeLog("photo_cache_end", {
          process_id: processId, operation_id: operationId,
          release_tag: config.releaseTag, experiment_id: config.experimentId,
          source, persistent_read: persistentRead, persistent_write: persistentWrite,
          vision_calls: visionCalls, completion,
        });
      },
    };
  }
  return { registerProcess, start };
}

export const photoCacheTelemetry = createPhotoCacheTelemetry();

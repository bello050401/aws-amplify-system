import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPhotoObservationStore } from "../lib/ai/productPage/photoObservation";
import { createPhotoObservationReuse, type ObservationStore } from "../lib/ai/productPage/photoObservationReuse";
import { createPhotoCacheTelemetry, photoCacheTelemetryConfig } from "../lib/ai/productPage/photoObservationTelemetry";

const at = Date.parse("2026-09-30T08:00:00.000Z");
const env = {
  NODE_ENV: "production",
  PHOTO_CACHE_TELEMETRY_ENABLED: "1",
  PHOTO_CACHE_TELEMETRY_APP_ID: "d4hkkg7dty2du",
  PHOTO_CACHE_TELEMETRY_BRANCH: "claude/inventory-management-system-5vbvc7",
  PHOTO_CACHE_TELEMETRY_RELEASE_TAG: "A",
  PHOTO_CACHE_TELEMETRY_EXPERIMENT_ID: "6cf7df0a-5e98-447b-a9e1-5b9b68745324",
  PHOTO_CACHE_TELEMETRY_START_AT: "2026-09-30T07:00:00.000Z",
  PHOTO_CACHE_TELEMETRY_END_AT: "2026-09-30T09:00:00.000Z",
};
type Event = { event: string; fields: Record<string, string | number> };
const events: Event[] = [];
const telemetry = createPhotoCacheTelemetry(env, () => at, (event, fields) => events.push({ event, fields }));
const ends = () => events.filter(row => row.event === "photo_cache_end").map(row => row.fields);
const image = new Uint8Array([1, 2, 3]);

function model(get: () => unknown, create: () => unknown, update: () => unknown) {
  return { get, create, update } as unknown as NonNullable<Parameters<typeof createPhotoObservationStore>[0]>;
}
function row(cacheKey: string, value = '["背もたれは黒い"]') {
  return { cacheKey, field: "photo-observation-v1", status: "FOUND", value };
}

async function main() {
  if (process.argv.includes("--child-process-id")) {
    const rows: Event[] = [];
    createPhotoCacheTelemetry(env, () => at, (event, fields) => rows.push({ event, fields })).registerProcess();
    process.stdout.write(String(rows[0]?.fields.process_id ?? ""));
    return;
  }
  assert.equal(photoCacheTelemetryConfig({ ...env, PHOTO_CACHE_TELEMETRY_ENABLED: "0" }, at), null);
  assert.equal(photoCacheTelemetryConfig({ ...env, PHOTO_CACHE_TELEMETRY_BRANCH: "production" }, at), null);
  assert.equal(photoCacheTelemetryConfig(env, Date.parse(env.PHOTO_CACHE_TELEMETRY_END_AT)), null);
  assert.equal(photoCacheTelemetryConfig({ ...env, PHOTO_CACHE_TELEMETRY_END_AT: "2026-10-04T09:00:00.000Z" }, at), null);
  assert.equal(photoCacheTelemetryConfig({ ...env,
    PHOTO_CACHE_TELEMETRY_START_AT: "2026-02-30T00:00:00.000Z",
    PHOTO_CACHE_TELEMETRY_END_AT: "2026-03-03T00:00:00.000Z",
  }, Date.parse("2026-03-02T12:00:00.000Z")), null);
  assert.equal(photoCacheTelemetryConfig(env, at)?.releaseTag, "A");

  const disabledRows: Event[] = [];
  const disabled = createPhotoCacheTelemetry({ ...env, PHOTO_CACHE_TELEMETRY_ENABLED: "0" }, () => at,
    (event, fields) => disabledRows.push({ event, fields }));
  const disabledReuse = createPhotoObservationReuse({ read: async () => null, write: async () => undefined },
    async () => ["背もたれは黒い"], disabled);
  assert.deepEqual(await disabledReuse(image, "model", "prompt"), ["背もたれは黒い"]);
  assert.deepEqual(disabledRows, [], "Disabled measurement must not change observation or log");

  telemetry.registerProcess();
  telemetry.registerProcess();
  assert.equal(events.filter(row => row.event === "photo_cache_process_start").length, 1);
  const processId = String(events[0].fields.process_id);
  const child = spawnSync(process.execPath, ["--import", "tsx", process.argv[1], "--child-process-id"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^[0-9a-f-]{36}$/);
  assert.notEqual(child.stdout, processId, "A separate Node process needs a separate process ID");

  const rows = new Map<string, string[]>();
  const store: ObservationStore = {
    async read(key) { return rows.get(key) ?? null; },
    async write(key, value) { rows.set(key, value); },
  };
  let calls = 0;
  const vision = async (_bytes: Uint8Array, operation?: { markVisionCall(): void } | null) => {
    operation?.markVisionCall(); calls++; return ["背もたれは黒い"];
  };
  const reuse = createPhotoObservationReuse(store, vision, telemetry);
  assert.deepEqual(await reuse(image, "model-a", "prompt-a"), ["背もたれは黒い"]);
  assert.deepEqual(await reuse(image, "model-a", "prompt-a"), ["背もたれは黒い"]);
  const restarted = createPhotoObservationReuse(store, vision, telemetry);
  assert.deepEqual(await restarted(image, "model-a", "prompt-a"), ["背もたれは黒い"]);
  assert.equal(calls, 1);
  assert.deepEqual(ends().slice(0, 3).map(e => [e.source, e.persistent_read, e.persistent_write, e.vision_calls]), [
    ["vision", "miss", "success", 1],
    ["memory", "not_attempted", "not_attempted", 0],
    ["persistent", "hit", "not_attempted", 0],
  ]);
  assert(ends().slice(0, 3).every(e => e.process_id === processId));

  let releaseVision!: (value: string[]) => void;
  const gate = new Promise<string[]>(resolve => { releaseVision = resolve; });
  const shared = createPhotoObservationReuse({ read: async () => null, write: async () => undefined },
    async (_bytes, operation) => { operation?.markVisionCall(); return gate; }, telemetry);
  const leader = shared(new Uint8Array([7]), "model", "prompt");
  const follower = shared(new Uint8Array([7]), "model", "prompt");
  releaseVision(["脚は茶色い"]);
  await Promise.all([leader, follower]);
  const pair = ends().slice(-2);
  assert.deepEqual(pair.map(e => e.source).sort(), ["inflight", "vision"]);
  assert.notEqual(pair[0].operation_id, pair[1].operation_id);
  assert.equal(pair.find(e => e.source === "inflight")?.vision_calls, 0);

  for (const [number, outcome] of ["null", "throw", "empty"].entries()) {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const concurrent = createPhotoObservationReuse({ read: async () => null, write: async () => undefined },
      async (_bytes, operation) => {
        operation?.markVisionCall();
        await wait;
        if (outcome === "throw") throw new Error("SECRET_VISION_FAILURE");
        return outcome === "null" ? null : [];
      }, telemetry);
    const before = ends().length;
    const a = concurrent(new Uint8Array([20 + number]), "model", "prompt");
    const b = concurrent(new Uint8Array([20 + number]), "model", "prompt");
    release();
    assert.deepEqual(await Promise.all([a, b]), [[], []], "Public result stays an empty array");
    const finished = ends().slice(before);
    assert.equal(finished.length, 2);
    assert.equal(finished.find(e => e.source === "inflight")?.vision_calls, 0);
    assert.deepEqual(finished.map(e => e.completion).sort(),
      outcome === "empty" ? ["completed", "completed"] : ["failed", "failed"]);
  }

  const invalidStore = createPhotoObservationStore(model(
    () => ({ data: row("private-key", "SECRET_PHOTO_BAD_JSON"), errors: null }),
    () => ({ data: row("private-key"), errors: null }),
    () => { throw new Error("update must not run"); },
  ));
  const invalid = createPhotoObservationReuse(invalidStore, vision, telemetry);
  await invalid(new Uint8Array([8]), "model", "prompt");
  assert.equal(ends().at(-1)?.persistent_read, "invalid");

  const readErrorStore = createPhotoObservationStore(model(
    () => ({ data: null, errors: [{ message: "SECRET_ERROR_BODY" }] }),
    () => ({ data: null, errors: [{ message: "create denied" }] }),
    () => ({ data: null, errors: [{ message: "update denied" }] }),
  ));
  const readError = createPhotoObservationReuse(readErrorStore, vision, telemetry);
  assert.deepEqual(await readError(new Uint8Array([9]), "model", "prompt"), ["背もたれは黒い"]);
  assert.deepEqual([ends().at(-1)?.persistent_read, ends().at(-1)?.persistent_write], ["error", "error"]);

  let updated = 0;
  const measurementOperation = {
    markRead: () => undefined, markWrite: () => undefined,
    markVisionCall: () => undefined, finish: () => undefined,
  };
  let activeModel = model(
    () => ({ data: null, errors: null }),
    () => ({ data: null, errors: null }),
    () => ({ data: null, errors: null }),
  );
  const lateBound = createPhotoObservationStore(undefined, () => activeModel);
  activeModel = model(
    () => ({ data: row("private-key"), errors: null }),
    () => ({ data: null, errors: null }),
    () => ({ data: null, errors: null }),
  );
  assert.deepEqual(await lateBound.read("private-key"), ["背もたれは黒い"],
    "A model selected after store construction must be used at read time");
  let lateWrites = 0;
  activeModel = model(
    () => ({ data: null, errors: null }),
    () => { lateWrites++; return { data: row("private-key"), errors: null }; },
    () => ({ data: null, errors: null }),
  );
  await lateBound.write("private-key", ["背もたれは黒い"], measurementOperation);
  assert.equal(lateWrites, 1, "The current model must also be selected at write time");
  activeModel = model(
    () => ({ data: null, errors: null }),
    () => { lateWrites++; return { data: null, errors: null }; },
    () => ({ data: null, errors: null }),
  );
  await lateBound.write("private-key", ["背もたれは黒い"]);
  assert.equal(lateWrites, 2, "Disabled measurement still resolves the model at write time");
  const ackStore = createPhotoObservationStore(model(
    () => ({ data: null, errors: null }),
    () => ({ data: null, errors: [{ message: "create conflict" }] }),
    () => { updated++; return { data: row("private-key"), errors: null }; },
  ));
  await ackStore.write("private-key", ["背もたれは黒い"], measurementOperation);
  assert.equal(updated, 1, "Final update acknowledgment establishes write success");
  const missingAck = createPhotoObservationStore(model(
    () => ({ data: null, errors: null }),
    () => ({ data: null, errors: null }),
    () => ({ data: null, errors: null }),
  ));
  await assert.rejects(missingAck.write("private-key", ["背もたれは黒い"], measurementOperation));
  let disabledUpdates = 0;
  const unchangedWrite = createPhotoObservationStore(model(
    () => ({ data: null, errors: null }),
    () => ({ data: null, errors: null }),
    () => { disabledUpdates++; return { data: null, errors: null }; },
  ));
  await unchangedWrite.write("private-key", ["背もたれは黒い"]);
  assert.equal(disabledUpdates, 0, "Disabled measurement preserves the former create-only path");

  const failed = createPhotoObservationReuse({ read: async () => null, write: async () => undefined },
    async (_bytes, operation) => { operation?.markVisionCall(); return null; }, telemetry);
  assert.deepEqual(await failed(new Uint8Array([10]), "model", "prompt"), []);
  assert.deepEqual([ends().at(-1)?.source, ends().at(-1)?.completion, ends().at(-1)?.vision_calls], ["none", "failed", 1]);
  const empty = createPhotoObservationReuse(store, async (_bytes, operation) => {
    operation?.markVisionCall(); return [];
  }, telemetry);
  assert.deepEqual(await empty(new Uint8Array([11]), "model", "prompt"), []);
  assert.deepEqual([ends().at(-1)?.source, ends().at(-1)?.completion], ["vision", "completed"]);

  const logText = JSON.stringify(events);
  for (const forbidden of ["SECRET", "private-key", "背もたれ", "photo-observation:v1:"]) {
    assert(!logText.includes(forbidden), `Telemetry leaked a forbidden value: ${forbidden}`);
  }
  assert(ends().every(e => e.completion === "completed" || e.completion === "failed"));
  console.log("Photo cache telemetry: gates, process/operation IDs, branches, acknowledgments and no-content logging passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

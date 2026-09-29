import assert from "node:assert/strict";
import { createPhotoObservationReuse, type ObservationStore } from "@/lib/ai/productPage/photoObservationReuse";

async function main() {
const rows = new Map<string, string[]>();
const store: ObservationStore = {
  async read(key) { return rows.get(key) ?? null; },
  async write(key, observations) { rows.set(key, observations); },
};
const photo = new Uint8Array([1, 2, 3]);
let calls = 0;
const observe = async () => { calls++; return ["背もたれは黒い"]; };

// Separate instances simulate a server process restart while sharing persistent storage.
const first = createPhotoObservationReuse(store, observe);
assert.deepEqual(await first(photo, "model-a", "prompt-1"), ["背もたれは黒い"]);
const restarted = createPhotoObservationReuse(store, observe);
assert.deepEqual(await restarted(photo, "model-a", "prompt-1"), ["背もたれは黒い"]);
assert.equal(calls, 1, "Identical bytes and specification reuse the saved observation");

await restarted(new Uint8Array([1, 2, 4]), "model-a", "prompt-1");
await restarted(photo, "model-a", "prompt-2");
await restarted(photo, "model-b", "prompt-1");
assert.equal(calls, 4, "Photo bytes, prompt version and model all invalidate reuse");

let attempts = 0;
const failed = createPhotoObservationReuse(store, async () => { attempts++; return null; });
const missing = new Uint8Array([9, 8, 7]);
assert.deepEqual(await failed(missing, "model-a", "prompt-1"), []);
assert.deepEqual(await failed(missing, "model-a", "prompt-1"), []);
assert.equal(attempts, 2, "Unavailable observations are neither saved nor remembered");

const empty = createPhotoObservationReuse(store, async () => { attempts++; return []; });
await empty(missing, "model-a", "prompt-1");
const emptyAfterRestart = createPhotoObservationReuse(store, async () => { throw new Error("Should reuse empty result"); });
assert.deepEqual(await emptyAfterRestart(missing, "model-a", "prompt-1"), []);
assert.equal(attempts, 3, "A valid empty observation is reusable");
console.log("Photo observation persistent reuse: 4 passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

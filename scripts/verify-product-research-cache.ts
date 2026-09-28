import assert from "node:assert/strict";
import { createResearchCache } from "../lib/ai/productPage/researchCache";
async function main() {
  let time = 0;
  let calls = 0;
  const cached = createResearchCache<number>(() => time);
  const load = async () => { calls++; return 42; };
  assert.deepEqual(await Promise.all([cached("same", load, 0), cached("same", load, 0)]), [42, 42]);
  assert.equal(calls, 1);
  assert.equal(await cached("same", load, 0), 42);
  assert.equal(calls, 1);
  time += 30 * 60_000;
  await cached("same", load, 0);
  assert.equal(calls, 2);
  const fail = async () => { calls++; throw new Error("offline"); };
  assert.equal(await cached("failed", fail, 0), 0);
  await cached("failed", fail, 0);
  assert.equal(calls, 3);
  time += 60_000;
  await cached("failed", fail, 0);
  assert.equal(calls, 4);
  console.log("Research concurrent reuse and failure TTL checks passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

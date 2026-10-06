import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { exactVisibilityPcJob } from "./visibilityTransitionOnce.mjs";

const HASH = /^[a-f0-9]{64}$/;
const keyOf = job => createHash("sha256").update(
  `${job.action}\0${job.target.shopId}\0${job.target.remoteId}`).digest("hex");
const dirOf = root => join(root, "visibility-pc-jobs");

/** Inbox only: enqueue never opens Shops or claims a visibility transition. */
export async function enqueueVisibilityPcJob(root, job) {
  if (typeof root !== "string" || !isAbsolute(root) || !exactVisibilityPcJob(job))
    throw Error("Invalid BELLO visibility PC job");
  const key = keyOf(job);
  const dir = dirOf(root);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${key}.json`);
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(job) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return { key, status: "QUEUED_NO_SEND" };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const saved = await readVisibilityPcJob(root, key);
    if (JSON.stringify(saved) !== JSON.stringify(job))
      throw Error("Visibility PC job conflict");
    return { key, status: "ALREADY_QUEUED_NO_SEND" };
  }
}

export async function readVisibilityPcJob(root, key) {
  if (typeof root !== "string" || !isAbsolute(root) || !HASH.test(key))
    throw Error("Invalid visibility PC job key");
  const bytes = await readFile(join(dirOf(root), `${key}.json`));
  if (bytes.length < 1 || bytes.length > 8192)
    throw Error("Invalid visibility PC job size");
  const job = JSON.parse(bytes.toString("utf8"));
  if (!exactVisibilityPcJob(job) || keyOf(job) !== key)
    throw Error("Invalid saved visibility PC job");
  return job;
}

export async function listVisibilityPcJobs(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw Error("Absolute queue root required");
  let names;
  try { names = await readdir(dirOf(root)); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (names.length > 100 || names.some(name => !/^[a-f0-9]{64}\.json$/.test(name)))
    throw Error("Visibility PC inbox changed");
  return Promise.all(names.sort().map(async name => {
    const key = name.slice(0, 64);
    const job = await readVisibilityPcJob(root, key);
    const stem = `${job.target.shopId}-${job.target.remoteId}-${job.action}`;
    let attempted = false;
    let outcome = null;
    try {
      await readFile(join(root, "visibility-transition-once", `${stem}.claim.json`));
      attempted = true;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (attempted) {
      try {
        const result = JSON.parse(await readFile(join(root,
          "visibility-transition-once", `${stem}.result.json`), "utf8"));
        outcome = result?.remoteId === job.target.remoteId &&
          result?.action === job.action &&
          ["STOP_VERIFIED", "RELIST_VERIFIED", "UNKNOWN"].includes(result?.outcome) ?
            result.outcome : "UNKNOWN";
      } catch { outcome = "UNKNOWN"; }
    }
    return { key, job, attempted, outcome };
  }));
}

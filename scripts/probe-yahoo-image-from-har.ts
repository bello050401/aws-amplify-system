/** Explicit operator probe. Creates ONE unlisted image asset, never a listing.
 * Usage: node --conditions=react-server --import tsx scripts/probe-yahoo-image-from-har.ts HAR IMAGE RESULT_JSON
 * The result file is created exclusively BEFORE sending, preventing accidental
 * replay using the same path even when the network acknowledgement is lost.
 * Do not choose another result path to retry an uncertain upload.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { YahooWebSession } from "../lib/listing/yahooAuction/webHttpSession";

async function main() {
  const [harPath, imagePath, resultPath, ...extra] = process.argv.slice(2);
  if (!harPath || !imagePath || !resultPath || extra.length ||
      ![harPath, imagePath, resultPath].every(path.isAbsolute) || !resultPath.endsWith(".json")) throw Error();
  if ((await fs.stat(harPath)).size > 100 * 1024 * 1024 || (await fs.stat(imagePath)).size > 5 * 1024 * 1024) throw Error();
  const har = JSON.parse((await fs.readFile(harPath, "utf8")).replace(/^\uFEFF/, ""));
  const session = YahooWebSession.fromHar(har);
  if (!session.ok) { console.log(JSON.stringify(session)); process.exitCode = 1; return; }
  const read = await session.value.inspectInput();
  if (!read.ok) { console.log(JSON.stringify(read)); process.exitCode = 1; return; }
  const image = await fs.readFile(imagePath);
  const evidence = { execution: "LOCAL_NODE", sourceSha256: createHash("sha256").update(image).digest("hex"),
    startedAt: new Date().toISOString(), operation: "IMAGE_ASSET_ONLY", publicationAttempted: false };
  const output = await fs.open(resultPath, "wx", 0o600);
  try {
    await output.writeFile(JSON.stringify({ ...evidence, state: "PENDING_OR_UNKNOWN" }, null, 2) + "\n");
    await output.sync();
    const result = await session.value.probeImageUpload(image, path.basename(imagePath));
    // Only vetted asset references/metadata or fixed error codes; no auth or raw response.
    await fs.writeFile(resultPath, JSON.stringify({ ...evidence, completedAt: new Date().toISOString(), result }, null, 2) + "\n");
    console.log(JSON.stringify(result.ok ? { ok: true, operation: evidence.operation,
      width: result.value.width, height: result.value.height, publicationAttempted: false } : result));
    if (!result.ok) process.exitCode = 1;
  } finally { await output.close(); }
}
main().catch(() => { console.log(JSON.stringify({ ok: false, code: "PROBE_NOT_COMPLETED_CHECK_LOCAL_RESULT" })); process.exitCode = 1; });

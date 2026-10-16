/** Operator-only pre-publication probe. Reuses the verified captured image.
 * Derives product data from the user's successful preview capture, but obtains
 * every token/form from fresh HTTPS responses. No image upload or final listing.
 * Usage: node --conditions=react-server --import tsx scripts/probe-yahoo-preview-from-har.ts HAR RESULT_JSON
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { YahooWebSession, parseYahooImageResponse } from "../lib/listing/yahooAuction/webHttpSession";
import { verifyPreview, validPreviewInput, type YahooFixedPreviewInput } from "../lib/listing/yahooAuction/webHttpPreview";

function plainDescription(value: string): string {
  const walk = (n: DefaultTreeAdapterMap["node"]): string => {
    if (n.nodeName === "#text" && "value" in n) return n.value;
    if ("tagName" in n) {
      if (n.tagName !== "br" || n.attrs.length) throw Error();
      return "\n";
    }
    if ("childNodes" in n) return n.childNodes.map(walk).join("");
    throw Error();
  };
  return walk(parseFragment(value));
}
async function main() {
  const [harPath, resultPath, ...extra] = process.argv.slice(2);
  if (!harPath || !resultPath || extra.length || !path.isAbsolute(harPath) || !path.isAbsolute(resultPath) ||
      !resultPath.endsWith(".json") || (await fs.stat(harPath)).size > 100 * 1024 * 1024) throw Error();
  const bytes = await fs.readFile(harPath);
  const har = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw Error();
  const candidates = entries.filter(e => e.request?.method === "POST" &&
    e.request.url === "https://auctions.yahoo.co.jp/sell/jp/show/preview" && e.response?.status === 200);
  const source = candidates.at(-1);
  if (!source || source.request.postData?.mimeType !== "application/x-www-form-urlencoded" ||
      typeof source.request.postData?.text !== "string" || typeof source.response?.content?.text !== "string") throw Error();
  const p = new URLSearchParams(source.request.postData.text);
  for (const k of ["Title", "Description", "istatus", "BidOrBuyPrice", "Quantity", "category", "ClosingYMD", "ClosingTime",
    "shipping", "shipname1", "loc_cd", "shipschedule", "ImageFullPath1", "ImageWidth1", "ImageHeight1"])
    if (p.getAll(k).length !== 1) throw Error();
  const input = { title: p.get("Title"), description: plainDescription(p.get("Description")!), condition: p.get("istatus"),
    priceYen: Number(p.get("BidOrBuyPrice")), quantity: Number(p.get("Quantity")), categoryId: p.get("category"),
    closingDateJst: p.get("ClosingYMD"), closingHourJst: Number(p.get("ClosingTime")),
    shipping: { payer: p.get("shipping"), method: p.get("shipname1"), prefecture: p.get("loc_cd"), schedule: p.get("shipschedule") },
  } as YahooFixedPreviewInput;
  const image = parseYahooImageResponse({ images: [{ url: p.get("ImageFullPath1"), width: p.get("ImageWidth1"), height: p.get("ImageHeight1") }] });
  if (!image || !validPreviewInput(input, image) || !verifyPreview(source.response.content.text, input, image)) throw Error();
  const session = YahooWebSession.fromHar(har);
  if (!session.ok) { console.log(JSON.stringify(session)); process.exitCode = 1; return; }
  const record = { execution: "LOCAL_NODE", transport: "HTTPS", operation: "PREVIEW_ONLY_EXISTING_IMAGE",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"), startedAt: new Date().toISOString(),
    imageUploaded: false, publicationAttempted: false };
  const output = await fs.open(resultPath, "wx", 0o600);
  try {
    await output.writeFile(JSON.stringify({ ...record, state: "PENDING" }, null, 2) + "\n");
    await output.sync();
    const result = await session.value.previewFixedListing(input, image);
    await fs.writeFile(resultPath, JSON.stringify({ ...record, completedAt: new Date().toISOString(), result }, null, 2) + "\n");
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } finally { await output.close(); }
}
main().catch(() => { console.log(JSON.stringify({ok:false,code:"PREVIEW_PROBE_NOT_COMPLETED_CHECK_LOCAL_RESULT"})); process.exitCode=1; });

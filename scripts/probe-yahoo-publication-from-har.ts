/** One authorized B005105 public test. Fixed durable path prevents reruns. Never use as the production job runner. */
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
  const [harPath, ...extra] = process.argv.slice(2);
  const resultPath = "C:/Users/win/Documents/Codex/2026-10-16/yahoo-http-proof/publication-b005105-once.json";
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
  if (createHash("sha256").update(bytes).digest("hex") !== "a0c17f14fe4b15146d72cd346fce5ccdc5fb95058325d4d8adaccc65a321e42a" ||
      input.title !== "THONET トーネット アームチェア ダイニングチェア 1脚" || input.priceYen !== 99999 || input.quantity !== 1 ||
      process.env.BELLO_YAHOO_AUTHORIZED_TEST !== "B005105_99999_1") throw Error();
  const session = YahooWebSession.fromHar(har);
  if (!session.ok) { console.log(JSON.stringify(session)); process.exitCode = 1; return; }
  const record = { execution: "LOCAL_NODE", transport: "HTTPS", operation: "AUTHORIZED_B005105_PUBLISH_ONCE",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"), startedAt: new Date().toISOString(),
    imageUploaded: false, publicationAttempted: false };
  const output = await fs.open(resultPath, "wx", 0o600);
  const save = async (data: unknown) => {
    const json = Buffer.from(JSON.stringify(data,null,2)+"\n");
    await output.write(json,0,json.length,0); await output.truncate(json.length); await output.sync();
  };
  try {
    await save({ ...record, state: "PREPARING", inventoryId: "57b4b2b5-d6ad-435a-b303-5d412405a44c" });
    const preview = await session.value.previewFixedListing(input,image);
    if (!preview.ok) { await save({...record,state:"NOT_SENT",result:preview}); console.log(JSON.stringify(preview)); return; }
    let sentAt: string | null = null;
    const result = await session.value.publishPreparedListing({title:input.title,priceYen:99999,quantity:1,termsAccepted:true}, async evidence => {
      sentAt = new Date().toISOString();
      await save({...record,state:"SEND_RESERVED",publicationAttempted:true,sentAt,evidence,
        inventoryId:"57b4b2b5-d6ad-435a-b303-5d412405a44c",mustReconcileBeforeAnyRetry:true});
    });
    await save({...record,publicationAttempted:!!sentAt,sentAt,completedAt:new Date().toISOString(),
      inventoryId:"57b4b2b5-d6ad-435a-b303-5d412405a44c",result,mustReconcileBeforeAnyRetry:!!sentAt});
    console.log(JSON.stringify(result));
  } finally { await output.close(); }
}
main().catch(() => { console.log(JSON.stringify({ok:false,code:"PUBLICATION_PROBE_NOT_COMPLETED_CHECK_LOCAL_RESULT"})); process.exitCode=1; });

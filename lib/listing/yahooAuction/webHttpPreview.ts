import "server-only";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { YahooUploadedImage } from "./webHttpSession";

// These are the three pre-publication forms observed in the 2026-10-16 HAR.
// No final publication URL is accepted by this module.
export const YAHOO_ORIGIN = "https://auctions.yahoo.co.jp";
export const CATEGORY_PATH = "/sell/jp/show/topsubmit";
export const SELECTED_INPUT_PATH = "/sell/jp/show/submit";
export const PREVIEW_PATH = "/sell/jp/show/preview";
type Node = DefaultTreeAdapterMap["node"];
type El = DefaultTreeAdapterMap["element"];
const attr = (el: El, key: string) => el.attrs.find(a => a.name === key)?.value;
function nodes(root: Node): El[] {
  const pending = [root], result: El[] = [];
  let count = 0;
  while (pending.length) {
    const n = pending.pop()!;
    if (++count > 30_000) throw Error("DOCUMENT_LIMIT");
    if ("tagName" in n) result.push(n);
    if ("childNodes" in n) pending.push(...[...n.childNodes].reverse());
  }
  return result;
}
function documentNodes(html: string) {
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw Error("DOCUMENT_LIMIT");
  return nodes(parse(html));
}
function singleForm(html: string, name: string, action: string | null): El {
  const forms = documentNodes(html).filter(n => n.tagName === "form" && attr(n, "name") === name && attr(n, "method") === "post");
  if (forms.length !== 1) throw Error("FORM_CHANGED");
  const actual = attr(forms[0], "action");
  if (action === null ? !!actual : !actual || new URL(actual, YAHOO_ORIGIN).href !== YAHOO_ORIGIN + action)
    throw Error("FORM_CHANGED");
  return forms[0];
}
// Only observed hidden fields are carried between fresh same-origin responses.
// No capture token, arbitrary action, paid option or opaque POST body is replayed.
const hiddenNames = new Set((`aID oldAID mode category md5 .crumb tos submitTipsDisp fnavi CloseEarly pagetype
isDraftChecked saveIndex newsubmitform retpolicy_comment info01 info02 info03 experimentId bucketId
appraisal_info appraisal_select isY2S y2sPattern listing_type y2s_product_id y2s_department y2s_category_id
y2s_sub_category_id y2s_brand_id y2s_tmpType y2s_tmpAucBrandId y2s_tmpSize isCarTotalAmountCategory
isSodaAppraisalTarget appraisal_code draftIndex thumbNail auction_server uploadserver ImageCntMax ypoint encode
catalog_id catalog_jan_code catalog_name catalog_brand_id productSearchTitle submit_maker_brand_id brand_line_id
is_appraisal_brand has_shrink is_shrink_required_for_appraisal item_segment_id item_spec_size_id item_spec_size_type
box_condition wrapping_paper_condition accessories submit_description Description Description_rte Description_rte_work
Description_plain_work Description_plain dskPayment shiptime loc_cd shipping shippinginput is_yahuneko_nekoposu_ship
is_yahuneko_taqbin_compact_ship is_yahuneko_taqbin_ship is_jp_yupacket_official_ship is_jp_yupacket_post_mini_official_ship
is_jp_yupacket_plus_official_ship is_jp_yupack_official_ship is_other_ship itemsize itemweight submitUnixtime Duration
tmpClosingYMD tmpClosingTime featuredRadio featuredAmount oldCpaAmount cpaAmount minBidRating retpolicy ppayreg
catD largeCat burl eappid comeAgain submitUrl historyUrl type _crumb ypmOK exhibitcategory nonpremium
isnonpremiumfromtransition crumb catSuggestSrc Title istatus Quantity shipschedule salesmode StartPrice BidOrBuyPrice
ClosingYMD ClosingTime numResubmit shipname1 shipmethod markdown`).split(/\s+/));
for (let i = 1; i <= 10; i++) for (const prefix of ["image_comment", "ImageFullPath", "ImageWidth", "ImageHeight"]) hiddenNames.add(prefix + i);
for (let i = 1; i <= 10; i++) hiddenNames.add(`Image${i}Uploaded`);
function hiddenFields(form: El, relistId?: string): URLSearchParams {
  const fields = new URLSearchParams();
  for (const n of nodes(form)) {
    const name = attr(n, "name");
    if (n.tagName !== "input" || attr(n, "type") !== "hidden" || !name || !hiddenNames.has(name) || attr(n, "disabled") !== undefined) continue;
    const value = attr(n, "value") ?? "";
    if (value.length > 60_000 || fields.has(name) && fields.get(name) !== value) throw Error("FORM_CHANGED");
    fields.set(name, value);
  }
  if (fields.get("mode") !== (relistId ? "oresubmit" : "submit") || fields.get("aID") !== (relistId ?? "") || fields.get("oldAID") !== "") throw Error("FORM_ID_CHANGED");
  return fields;
}
function requireToken(fields: URLSearchParams, key: string) {
  const v = fields.get(key);
  if (!v || v.length > 8192) throw Error("TOKEN_MISSING");
}

export type YahooFixedPreviewInput = {
  title: string; description: string; condition: "new" | "used10" | "used20" | "used40" | "used60" | "used80";
  priceYen: number; quantity: number; categoryId: string;
  closingDateJst: string; closingHourJst: number;
  relistId?: string;
  // First observed shipping configuration. Other configurations need their own evidence.
  shipping: { payer: "seller"; method: "家財おまかせ便" | "佐川急便"; prefecture: "11"; schedule: "2" };
};
export type YahooPreviewEvidence = {
  title: string; priceYen: number; quantity: number; categoryId: string;
  imageCount: number; shippingIncluded: true; shippingMethod: string;
  endAt: string; publicationAttempted: false;
};
export function validPreviewInput(input: YahooFixedPreviewInput, image: YahooUploadedImage): boolean {
  if (!input || typeof input.title !== "string" || !input.title.trim() || [...input.title].length > 65 ||
      typeof input.description !== "string" || !input.description.trim() || input.description.length > 30_000 ||
      !["new", "used10", "used20", "used40", "used60", "used80"].includes(input.condition) ||
      !Number.isSafeInteger(input.priceYen) || input.priceYen < 1 || input.priceYen > 999_999_999 ||
      !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 9 ||
      !/^[1-9]\d{0,11}$/.test(input.categoryId) || !/^\d{4}-\d{2}-\d{2}$/.test(input.closingDateJst) ||
      !Number.isSafeInteger(input.closingHourJst) || input.closingHourJst < 0 || input.closingHourJst > 23 ||
      input.shipping?.payer !== "seller" || !["家財おまかせ便", "佐川急便"].includes(input.shipping.method) ||
      input.shipping.prefecture !== "11" || input.shipping.schedule !== "2" ||
      (input.relistId !== undefined && !/^[a-z][0-9]{8,12}$/.test(input.relistId)) || !image) return false;
  try {
    const date = new Date(input.closingDateJst + "T00:00:00Z");
    const url = new URL(image.url);
    return date.toISOString().slice(0, 10) === input.closingDateJst && url.origin === "https://auctions.c.yimg.jp" &&
      !url.username && !url.password && !url.search && !url.hash && url.href.length <= 4096 &&
      [image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 30_000);
  } catch { return false; }
}
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export type YahooPreviewImages = YahooUploadedImage | YahooUploadedImage[];
export const previewImages = (images: YahooPreviewImages): YahooUploadedImage[] => Array.isArray(images) ? images : [images];
export function validPreviewImages(input: YahooFixedPreviewInput, images: YahooPreviewImages) {
  const all = previewImages(images);
  return all.length >= 1 && all.length <= 10 && new Set(all.map(i => i.url)).size === all.length && all.every(i => validPreviewInput(input, i));
}
function applyInput(fields: URLSearchParams, input: YahooFixedPreviewInput, images: YahooPreviewImages) {
  const all = previewImages(images);
  if (!validPreviewImages(input, images)) throw Error("INVALID_INPUT");
  const serverSeconds = fields.get("submitUnixtime");
  if (!serverSeconds || !/^\d{10}$/.test(serverSeconds)) throw Error("FORM_TIME_MISSING");
  const serverTime = Number(serverSeconds) * 1000;
  const startDate = new Date(serverTime + 9 * 3600_000).toISOString().slice(0, 10);
  const days = (Date.parse(input.closingDateJst) - Date.parse(startDate)) / 86400_000;
  if (!Number.isInteger(days) || days < 1 || days > 7) throw Error("INVALID_END_DATE");
  const description = escapeHtml(input.description).replace(/\r?\n/g, "<br>");
  const values: Record<string, string> = {
    Title: input.title, Description: description,
    Description_plain: description, Description_plain_work: description,
    Description_rte: "", Description_rte_work: "", submit_description: "text",
    istatus: input.condition, Quantity: String(input.quantity), salesmode: "buynow",
    StartPrice: String(input.priceYen), BidOrBuyPrice: String(input.priceYen),
    loc_cd: input.shipping.prefecture, shipping: "seller", shippinginput: "now", shiptime: "payment",
    is_other_ship: "yes", shipname1: input.shipping.method, shipmethod: "other", shipschedule: input.shipping.schedule,
    ClosingYMD: input.closingDateJst, ClosingTime: String(input.closingHourJst), Duration: String(days),
    tmpClosingYMD: input.closingDateJst, tmpClosingTime: "", numResubmit: "0",
    featuredRadio: "", featuredAmount: "", oldCpaAmount: "", cpaAmount: "", minBidRating: "0", retpolicy: "0", ppayreg: "0",
    thumbNail: "", draftIndex: "", saveIndex: "0", isDraftChecked: "", isSodaAppraisalTarget: "",
    productSearchTitle: "", box_condition: "", wrapping_paper_condition: "", accessories: "",
  };
  for (const [k, v] of Object.entries(values)) fields.set(k, v);
  for (let i = 1; i <= 10; i++) {
    fields.set(`ImageFullPath${i}`, all[i-1]?.url ?? "");
    fields.set(`ImageWidth${i}`, all[i-1] ? String(all[i-1].width) : "");
    fields.set(`ImageHeight${i}`, all[i-1] ? String(all[i-1].height) : "");
    fields.set(`image_comment${i}`, "");
    // Existing pictures are locked in Yahoo's relist form. The workflow reads
    // these exact assets before confirmation rather than uploading replacements.
    if(input.relistId)fields.set(`Image${i}Uploaded`,all[i-1]?'1':'');
  }
  for (const k of [...fields.keys()]) if (/^is_(?:yahuneko|jp_)/.test(k)) fields.set(k, "");
}
export function categoryRequestFromInput(html: string, input: YahooFixedPreviewInput, image: YahooPreviewImages): URLSearchParams {
  const fields = hiddenFields(singleForm(html, "auction", PREVIEW_PATH));
  requireToken(fields, ".crumb");
  if (fields.get("category") !== "0") throw Error("FORM_CHANGED");
  applyInput(fields, input, image);
  return fields;
}
export function selectedInputRequest(html: string, categoryId: string): URLSearchParams {
  if (!/^[1-9]\d{0,11}$/.test(categoryId)) throw Error("INVALID_CATEGORY");
  const fields = hiddenFields(singleForm(html, "topsubmit", SELECTED_INPUT_PATH));
  requireToken(fields, "_crumb"); requireToken(fields, "crumb");
  fields.set("category", categoryId);
  return fields;
}
export function previewRequestFromInput(html: string, input: YahooFixedPreviewInput, image: YahooPreviewImages): URLSearchParams {
  const fields = hiddenFields(singleForm(html, "auction", PREVIEW_PATH), input.relistId);
  requireToken(fields, ".crumb");
  if (fields.get("category") !== input.categoryId) throw Error("CATEGORY_MISMATCH");
  applyInput(fields, input, image);
  return fields;
}
/** Read the immutable pictures from the exact owned-item relist form. */
export function relistingImagesFromInput(html:string,input:YahooFixedPreviewInput):YahooUploadedImage[]{
  if(!input.relistId)throw Error('RELIST_ID_REQUIRED');
  const fields=hiddenFields(singleForm(html,'auction',PREVIEW_PATH),input.relistId);
  requireToken(fields,'.crumb');
  if(fields.get('category')!==input.categoryId)throw Error('CATEGORY_MISMATCH');
  const images:YahooUploadedImage[]=[];let gap=false;
  for(let i=1;i<=10;i++){
    const url=fields.get(`ImageFullPath${i}`);
    if(!url){gap=true;continue;}
    if(gap||fields.get(`Image${i}Uploaded`)!=='1')throw Error('RELIST_IMAGE_CHANGED');
    images.push({url,width:Number(fields.get(`ImageWidth${i}`)),height:Number(fields.get(`ImageHeight${i}`))});
  }
  if(!validPreviewImages(input,images))throw Error('RELIST_IMAGE_CHANGED');
  return images;
}
export function verifyPreview(html: string, input: YahooFixedPreviewInput, images: YahooPreviewImages): YahooPreviewEvidence | null {
  try {
    if (!validPreviewImages(input, images)) return null;
    const all = previewImages(images);
    const form = singleForm(html, "auction", null), els = nodes(form);
    const values = new Map<string, string>();
    for (const el of els.filter(n => n.tagName === "input" && attr(n, "type") === "hidden")) {
      const key = attr(el, "name"); if (!key) continue;
      if (values.has(key)) return null;
      values.set(key, attr(el, "value") ?? "");
    }
    if (input.relistId ? values.get('aID') !== input.relistId : !!values.get('aID')) return null;
    const expected = { mode: input.relistId ? "oresubmit" : "submit", Title: input.title, category: input.categoryId, Quantity: String(input.quantity),
      istatus: input.condition, salesmode: "buynow", StartPrice: String(input.priceYen), BidOrBuyPrice: String(input.priceYen),
      Description: escapeHtml(input.description).replace(/\r?\n/g, "<br>"),
      shipping: "seller", shipname1: input.shipping.method, shipmethod: "other", loc_cd: "11", shipschedule: "2",
      ClosingYMD: input.closingDateJst, ClosingTime: String(input.closingHourJst), numResubmit: "0", AutoExtension: "no",
      Offer: "0", featuredAmount: "", cpaAmount: "", totalCharges: "0", insertionFeeTotal: "0", is_paypay_fleamarket_cross_listing: "0" };
    if (Object.entries(expected).some(([k, v]) => values.get(k) !== v)) return null;
    for (let i = 1; i <= 10; i++) {
      const image = all[i-1];
      if (image ? values.get(`ImageFullPath${i}`) !== image.url || values.get(`ImageWidth${i}`) !== String(image.width) || values.get(`ImageHeight${i}`) !== String(image.height) : !!values.get(`ImageFullPath${i}`)) return null;
    }
    if (!values.get(".crumb") || !documentNodes(html).some(n => n.tagName === "button" && attr(n, "id") === "auc_preview_submit_down")) return null;
    const end = values.get("endDate");
    if (!end || !/^\d{10}$/.test(end)) return null;
    const endAt = new Date(Number(end) * 1000).toISOString();
    const jst = new Date(Number(end) * 1000 + 9 * 3600_000).toISOString();
    if (jst.slice(0, 10) !== input.closingDateJst || Number(jst.slice(11, 13)) !== input.closingHourJst) return null;
    return { title: input.title, priceYen: input.priceYen, quantity: input.quantity, categoryId: input.categoryId,
      imageCount: all.length, shippingIncluded: true, shippingMethod: input.shipping.method, endAt, publicationAttempted: false };
  } catch { return null; }
}

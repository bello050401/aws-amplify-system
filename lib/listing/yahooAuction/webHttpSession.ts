import "server-only";
import { PUBLICATION_URL, publicationRequest, publicationResponseEvidence } from "./webHttpPublication";
import { parseListingEvidence, yahooAuctionIdValid, canCancelWithoutBids, zeroFeeCancellationPreview,
  type YahooListingEvidence } from "./webHttpListing";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { CATEGORY_PATH, SELECTED_INPUT_PATH, categoryRequestFromInput, selectedInputRequest,
  previewRequestFromInput, verifyPreview, validPreviewInput, type YahooFixedPreviewInput,
  type YahooPreviewEvidence } from "./webHttpPreview";

const ORIGIN = "https://auctions.yahoo.co.jp";
const INPUT_PATHS = new Set(["/jp/show/submit", "/sell/jp/show/submit"]);
const PREVIEW_PATH = "/sell/jp/show/preview";
const IMAGE_PATH = "/img/images/new";
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1000;
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Failure = "CAPTURE_INVALID" | "CAPTURE_TOO_OLD" | "AUTH_REQUIRED" |
  "ACCESS_DENIED" | "RATE_LIMITED" | "UNEXPECTED_RESPONSE" | "UNEXPECTED_FORM" | "READ_UNAVAILABLE";
type Result<T> = { ok: true; value: T } | { ok: false; code: Failure };
type PreviewResult = { ok: true; value: YahooPreviewEvidence } | { ok: false;
  code: Failure | "INVALID_PREVIEW_INPUT" | "PREVIEW_ALREADY_ATTEMPTED" | "PREVIEW_MISMATCH";
  stage: "INPUT" | "CATEGORY" | "SELECTED_INPUT" | "PREVIEW"; status?: number };
export type YahooUploadedImage = { url: string; width: number; height: number; thumbnail?: string };

/** Both image responses observed on 2026-10-16 omit thumbnail. The separate
 * thumbnail request returns the same images envelope, with string dimensions. */
export function parseYahooImageResponse(result: unknown): YahooUploadedImage | null {
  const assetUrl = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length > 4096) return false;
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      url.origin === "https://auctions.c.yimg.jp" && !url.search; } catch { return false; }
  };
  const data = result as { images?: { url?: unknown; width?: unknown; height?: unknown }[]; thumbnail?: unknown } | null;
  if (!Array.isArray(data?.images) || data.images.length !== 1) return null;
  const photo = data.images[0];
  const dimension = (v: unknown) => typeof v === "number" ? v : typeof v === "string" && /^[1-9]\d{0,4}$/.test(v) ? Number(v) : NaN;
  const width = dimension(photo?.width), height = dimension(photo?.height);
  if (!assetUrl(photo?.url) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 30_000 || height > 30_000 ||
      (data.thumbnail !== undefined && !assetUrl(data.thumbnail))) return null;
  return { url: photo.url, width, height, ...(data.thumbnail === undefined ? {} : { thumbnail: data.thumbnail as string }) };
}
type ImageResult = { ok: true; value: YahooUploadedImage } | { ok: false; code: Failure |
  "INVALID_IMAGE" | "INPUT_REQUIRED" | "UPLOAD_ALREADY_ATTEMPTED" | "IMAGE_RESULT_UNKNOWN";
  diagnostic?: { status?: number; responseKind: "JSON" | "HTML" | "OTHER" | "UNRECEIVED";
    stage: "SEND" | "HTTP" | "DECODE" | "ASSET_SHAPE" } };
type HarEntry = { startedDateTime?: string; request?: { url?: string; method?: string;
  headers?: { name?: string; value?: string }[] }; response?: { status?: number } };
export type YahooInputMetadata = {
  previewPath: typeof PREVIEW_PATH;
  conditionValues: string[];
  quantityValues: number[];
  shippingPayerDefault: "buyer" | "seller" | null;
  automaticRelistDefault: number | null;
  csrfPresent: true;
  imageCsrfPresent: boolean;
};

function validCookieHeader(cookie: unknown): cookie is string {
  if (typeof cookie !== "string" || !cookie || cookie.length > 48_000 || /[^\x20-\x7e]/.test(cookie)) return false;
  const names = new Set<string>();
  return cookie.split(";").every(pair => {
    const i = pair.trim().indexOf("="), name = pair.trim().slice(0, i);
    if (i < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || names.has(name)) return false;
    names.add(name); return true;
  });
}

function elements(root: Node): Element[] {
  const pending: Node[] = [root], found: Element[] = [];
  let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++count > 30_000) throw Error("DOCUMENT_LIMIT");
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
  }
  return found;
}
const attr = (el: Element, name: string) => el.attrs.find(a => a.name === name)?.value;

/** Returns only reviewed form metadata, never the HTML, token values or seller identity.
 * A parsed form is evidence of authenticated reading, not proof of a publication POST.
 */
export function inspectYahooInputHtml(html: string): Result<YahooInputMetadata> {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return { ok: false, code: "UNEXPECTED_FORM" };
  try {
    const all = elements(parse(html));
    const forms = all.filter(n => n.tagName === "form" && attr(n, "method")?.toLowerCase() === "post" &&
      (() => { try { const u = new URL(attr(n, "action") ?? "", ORIGIN);
        return u.origin === ORIGIN && u.pathname === PREVIEW_PATH && !u.search && !u.hash && !u.username && !u.password;
      } catch { return false; } })());
    if (forms.length !== 1) return { ok: false, code: "UNEXPECTED_FORM" };
    const fields = elements(forms[0]);
    const named = (name: string) => fields.filter(n => ["input", "select", "textarea"].includes(n.tagName) && attr(n, "name") === name);
    for (const name of ["Title", "Description", "Quantity", "istatus", "loc_cd", "shipschedule", "salesmode", "BidOrBuyPrice"])
      if (named(name).length === 0) return { ok: false, code: "UNEXPECTED_FORM" };
    const crumb = named(".crumb");
    if (crumb.length !== 1 || attr(crumb[0], "type") !== "hidden" || !attr(crumb[0], "value") ||
        attr(crumb[0], "value")!.length > 8192) return { ok: false, code: "UNEXPECTED_FORM" };
    const options = (name: string) => {
      const select = named(name);
      return select.length === 1 && select[0].tagName === "select" ?
        elements(select[0]).filter(n => n.tagName === "option" && attr(n, "disabled") === undefined) : [];
    };
    const conditions = options("istatus").map(n => attr(n, "value") ?? "").filter(Boolean);
    const quantities = options("Quantity").map(n => attr(n, "value") ?? "");
    if (!conditions.length || conditions.some(v => !["new", "used10", "used20", "used40", "used60", "used80"].includes(v)) ||
        !quantities.length || quantities.some(v => !/^[1-9]$/.test(v))) return { ok: false, code: "UNEXPECTED_FORM" };
    const shipping = named("shipping");
    const payer = shipping.length === 1 ? attr(shipping[0], "value") : undefined;
    const relistOptions = options("numResubmit");
    const chosen = relistOptions.filter(n => attr(n, "selected") !== undefined);
    const selectedRelist = chosen.length <= 1 ? chosen[0] ?? relistOptions[0] : undefined;
    const relist = selectedRelist ? attr(selectedRelist, "value") : undefined;
    return { ok: true, value: {
      previewPath: PREVIEW_PATH, conditionValues: conditions, quantityValues: quantities.map(Number),
      shippingPayerDefault: payer === "buyer" || payer === "seller" ? payer : null,
      automaticRelistDefault: relist && /^[0-3]$/.test(relist) ? Number(relist) : null,
      csrfPresent: true,
      imageCsrfPresent: fields.some(n => n.tagName === "input" && attr(n, "id") === "img_crumb" && !!attr(n, "value")),
    } };
  } catch { return { ok: false, code: "UNEXPECTED_FORM" }; }
}

async function limitedHtml(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_HTML_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw Error("BODY_LIMIT");
  }
  if (!response.body) throw Error("NO_BODY");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_HTML_BYTES) throw Error("BODY_LIMIT");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Server-only client for observed website HTTPS requests. Callers reserve
 * mutating operations durably before sending. There is no URL override,
 * browser fallback, redirect following or automatic retry.
 * Credentials stay in private fields, including when inspected or JSON serialized.
 */
export class YahooWebSession {
  #cookie: string;
  #inputUrl: string;
  #fetch: typeof fetch;
  #imageContext: { crumb: string; readAt: number } | null = null;
  #imageAttempted = false;
  #previewHtml: string | null = null;
  #previewAttempted = false;
  #publication: { body: URLSearchParams; evidence: YahooPreviewEvidence; preparedAt: number } | null = null;
  #publicationAttempted = false;
  #cancellationAttempted = false;
  #capturedAt: string;
  private constructor(cookie: string, inputUrl: string, fetchImpl: typeof fetch, capturedAt: string) {
    this.#cookie = cookie; this.#inputUrl = inputUrl; this.#fetch = fetchImpl;
    this.#capturedAt = capturedAt;
  }
  toJSON() { return { type: "YahooWebSession", credentials: "REDACTED" }; }

  static fromHar(har: unknown, options: { now?: number; fetchImpl?: typeof fetch } = {}): Result<YahooWebSession> {
    const entries = (har as { log?: { entries?: HarEntry[] } } | null)?.log?.entries;
    if (!Array.isArray(entries) || entries.length > 100_000) return { ok: false, code: "CAPTURE_INVALID" };
    const now = options.now ?? Date.now();
    let selected: { cookie: string; url: string; time: number } | null = null, old = false;
    for (const entry of entries) {
      if (entry?.request?.method !== "GET" || entry.response?.status !== 200) continue;
      let url: URL;
      try { url = new URL(entry.request.url ?? ""); } catch { continue; }
      if (url.origin !== ORIGIN || url.username || url.password || url.hash || !INPUT_PATHS.has(url.pathname) ||
          url.search !== "?category=0") continue;
      const time = Date.parse(entry.startedDateTime ?? "");
      if (!Number.isFinite(time) || time > now + 60_000) continue;
      if (now - time > MAX_CAPTURE_AGE_MS) { old = true; continue; }
      const headers = Array.isArray(entry.request.headers) ? entry.request.headers.filter(h => h &&
        typeof h.name === "string" && h.name.toLowerCase() === "cookie") : [];
      if (headers.length !== 1 || typeof headers[0].value !== "string") continue;
      const cookie = headers[0].value;
      if (validCookieHeader(cookie) && (!selected || time > selected.time)) selected = { cookie, url: url.href, time };
    }
    if (!selected) return { ok: false, code: old ? "CAPTURE_TOO_OLD" : "CAPTURE_INVALID" };
    return { ok: true, value: new YahooWebSession(selected.cookie, selected.url, options.fetchImpl ?? fetch, new Date(selected.time).toISOString()) };
  }

  /** Only an encrypted, dedicated server store may supply this record. Capture
   * age is an import constraint, not a fabricated cookie lifetime. Each operation
   * checks authentication live; no refresh endpoint has been observed yet. */
  static fromStoredSession(serialized: string, options: { now?: number; fetchImpl?: typeof fetch } = {}): Result<YahooWebSession> {
    try {
      if (serialized.length > 60_000) throw Error();
      const record = JSON.parse(serialized), now = options.now ?? Date.now();
      if (record?.schemaVersion !== 1 || record.origin !== ORIGIN || !validCookieHeader(record.cookieHeader) ||
          typeof record.capturedAt !== "string" || typeof record.verifiedAt !== "string" ||
          !Number.isFinite(Date.parse(record.capturedAt)) || !Number.isFinite(Date.parse(record.verifiedAt)) ||
          Date.parse(record.verifiedAt) < Date.parse(record.capturedAt) || Date.parse(record.verifiedAt) > now + 60_000)
        throw Error();
      return { ok: true, value: new YahooWebSession(record.cookieHeader, ORIGIN + "/jp/show/submit?category=0",
        options.fetchImpl ?? fetch, record.capturedAt) };
    } catch { return { ok: false, code: "CAPTURE_INVALID" }; }
  }

  /** Operator-only encrypted-store import. Secret material never appears in the
   * return value. The writer must not log, send to the browser or use ordinary DBs. */
  async persistVerifiedSession(writeEncrypted: (value: string) => Promise<void>): Promise<Result<YahooInputMetadata>> {
    const inspected = await this.inspectInput();
    if (!inspected.ok) return inspected;
    try {
      await writeEncrypted(JSON.stringify({ schemaVersion: 1, origin: ORIGIN, capturedAt: this.#capturedAt,
        verifiedAt: new Date().toISOString(), cookieHeader: this.#cookie }));
      return inspected;
    } catch { return { ok: false, code: "READ_UNAVAILABLE" }; }
  }

  async inspectInput(): Promise<Result<YahooInputMetadata>> {
    this.#publication = null;
    this.#imageContext = null;
    this.#previewHtml = null;
    try {
      const response = await this.#fetch(this.#inputUrl, { method: "GET", headers: { Cookie: this.#cookie, Accept: "text/html" },
        redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (response.status >= 300 && response.status < 400) {
        let login = false;
        try { const target = new URL(response.headers.get("location") ?? "", ORIGIN); login = target.origin === "https://login.yahoo.co.jp"; } catch {}
        await response.body?.cancel().catch(() => {});
        return { ok: false, code: login ? "AUTH_REQUIRED" : "UNEXPECTED_RESPONSE" };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, code: response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "ACCESS_DENIED" :
          response.status === 429 ? "RATE_LIMITED" : "UNEXPECTED_RESPONSE" };
      }
      if (response.redirected || (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "text/html") {
        await response.body?.cancel().catch(() => {});
        return { ok: false, code: "UNEXPECTED_RESPONSE" };
      }
      const html = await limitedHtml(response), result = inspectYahooInputHtml(html);
      if (result.ok) {
        this.#previewHtml = html;
        const nodes = elements(parse(html));
        const crumb = nodes.filter(n => n.tagName === "input" && attr(n, "id") === "img_crumb");
        const target = nodes.filter(n => n.tagName === "input" && attr(n, "id") === "imgUploadUrl");
        if (crumb.length === 1 && target.length === 1 && attr(crumb[0], "type") === "hidden" &&
            attr(crumb[0], "value") && attr(crumb[0], "value")!.length <= 8192 &&
            attr(target[0], "value") === ORIGIN + IMAGE_PATH)
          this.#imageContext = { crumb: attr(crumb[0], "value")!, readAt: Date.now() };
      }
      return result;
    } catch { return { ok: false, code: "READ_UNAVAILABLE" }; }
  }

  /** Exactly the captured pre-publication sequence. Reuses a previously uploaded
   * image, obtains fresh form tokens and checks the returned price/quantity/options.
   * Never follows the final confirmation button or returns its credential fields.
   * Currently limited to the observed fixed-price, seller-paid furniture flow.
   */
  async previewFixedListing(input: YahooFixedPreviewInput, image: YahooUploadedImage): Promise<PreviewResult> {
    let stage: Extract<PreviewResult, { ok: false }>["stage"] = "INPUT";
    if (!validPreviewInput(input, image)) return { ok: false, code: "INVALID_PREVIEW_INPUT", stage };
    if (this.#previewAttempted) return { ok: false, code: "PREVIEW_ALREADY_ATTEMPTED", stage };
    const inspected = await this.inspectInput();
    if (!inspected.ok) return { ...inspected, stage };
    this.#previewAttempted = true;
    let status: number | undefined;
    try {
      let body = categoryRequestFromInput(this.#previewHtml!, input, image);
      this.#previewHtml = null;
      let referer = this.#inputUrl;
      for (const path of [CATEGORY_PATH, SELECTED_INPUT_PATH, PREVIEW_PATH] as const) {
        stage = path === CATEGORY_PATH ? "CATEGORY" : path === SELECTED_INPUT_PATH ? "SELECTED_INPUT" : "PREVIEW";
        status = undefined;
        const response = await this.#fetch(ORIGIN + path, { method: "POST", body,
          headers: { Cookie: this.#cookie, Origin: ORIGIN, Referer: referer, Accept: "text/html" },
          redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000) });
        status = response.status;
        if (status !== 200 || response.redirected || (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "text/html") {
          await response.body?.cancel().catch(() => {});
          let login = false;
          try { login = new URL(response.headers.get("location") ?? "", ORIGIN).origin === "https://login.yahoo.co.jp"; } catch {}
          return { ok: false, stage, status, code: status === 401 || login ? "AUTH_REQUIRED" : status === 403 ? "ACCESS_DENIED" :
            status === 429 ? "RATE_LIMITED" : "UNEXPECTED_RESPONSE" };
        }
        const html = await limitedHtml(response);
        if (path === CATEGORY_PATH) body = selectedInputRequest(html, input.categoryId);
        else if (path === SELECTED_INPUT_PATH) body = previewRequestFromInput(html, input, image);
        else {
          const value = verifyPreview(html, input, image);
          if (value) {
            // A valid preview remains useful even if a changed final form cannot
            // be submitted. Publication is armed only by strict serialization.
            try { this.#publication = { body: publicationRequest(html, input, image), evidence: value, preparedAt: Date.now() }; }
            catch { this.#publication = null; }
          }
          return value ? { ok: true, value } : { ok: false, code: "PREVIEW_MISMATCH", stage, status };
        }
        referer = ORIGIN + path;
      }
      return { ok: false, code: "UNEXPECTED_FORM", stage };
    } catch { return { ok: false, code: status === undefined && stage !== "INPUT" ? "READ_UNAVAILABLE" : "UNEXPECTED_FORM", stage, status }; }
    finally { this.#previewHtml = null; }
  }

  /** Authorized operator probe. Caller must durably reserve the one attempt
   * before send, enforce account-wide spacing and reconcile any uncertainty.
   * No retry or redirect following; response evidence alone is not success. */
  async publishPreparedListing(approval: { title: string; priceYen: number; quantity: number; termsAccepted: true },
    beforeSend: (evidence: YahooPreviewEvidence) => Promise<void>) {
    if (this.#publicationAttempted) return { ok: false as const, code: "PUBLICATION_ALREADY_ATTEMPTED" };
    const prepared = this.#publication;
    if (!prepared || Date.now() - prepared.preparedAt > 5 * 60_000) return { ok: false as const, code: "FRESH_PREVIEW_REQUIRED" };
    if (approval.termsAccepted !== true || approval.title !== prepared.evidence.title ||
        approval.priceYen !== prepared.evidence.priceYen || approval.quantity !== prepared.evidence.quantity)
      return { ok: false as const, code: "APPROVAL_MISMATCH" };
    this.#publicationAttempted = true;
    this.#publication = null;
    try { await beforeSend(prepared.evidence); }
    catch { return { ok: false as const, code: "ATTEMPT_NOT_RESERVED" }; }
    let status: number | undefined;
    try {
      const response = await this.#fetch(PUBLICATION_URL, { method: "POST", body: prepared.body,
        headers: { Cookie: this.#cookie, Origin: ORIGIN, Referer: ORIGIN + PREVIEW_PATH, Accept: "text/html" },
        redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000) });
      status = response.status;
      if (status !== 200 || response.redirected || !(response.headers.get("content-type") ?? "").startsWith("text/html")) {
        await response.body?.cancel().catch(() => {});
        return { ok: false as const, code: "PUBLICATION_RESULT_UNKNOWN", status };
      }
      const evidence = publicationResponseEvidence(await limitedHtml(response));
      return { ok: false as const, code: "PUBLICATION_READBACK_REQUIRED", status, evidence };
    } catch { return { ok: false as const, code: "PUBLICATION_RESULT_UNKNOWN", status }; }
  }

  async inspectListing(auctionId: string): Promise<Result<YahooListingEvidence>> {
    if(!yahooAuctionIdValid(auctionId))return {ok:false,code:"UNEXPECTED_FORM"};
    try {
      const r=await this.#fetch(ORIGIN+'/jp/auction/'+auctionId,{method:'GET',headers:{Cookie:this.#cookie,Accept:'text/html'},
        redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20_000)});
      if(r.status!==200 || r.redirected || !(r.headers.get('content-type')??'').startsWith('text/html')) {
        await r.body?.cancel().catch(()=>{}); return {ok:false,code:r.status===401?'AUTH_REQUIRED':r.status===403?'ACCESS_DENIED':r.status===429?'RATE_LIMITED':'UNEXPECTED_RESPONSE'};
      }
      const evidence=parseListingEvidence(await limitedHtml(r),auctionId);
      return evidence?{ok:true,value:evidence}:{ok:false,code:'UNEXPECTED_FORM'};
    }catch{return {ok:false,code:'READ_UNAVAILABLE'};}
  }

  /** No fees/bids are accepted. The observed server also rejects a late bid
   * when hasCancelFee:false is sent. A transport error never triggers a retry. */
  async cancelListingWithoutFee(auctionId:string, expected:{title:string;priceYen:number;quantity:number},
    beforeSend:(evidence:YahooListingEvidence)=>Promise<void>) {
    if(this.#cancellationAttempted)return {ok:false as const,code:'CANCELLATION_ALREADY_ATTEMPTED'};
    const first=await this.inspectListing(auctionId);
    if(!first.ok)return first;
    const matches=(d:YahooListingEvidence)=>d.title===expected.title&&d.priceYen===expected.priceYen&&d.quantity===expected.quantity;
    if(!matches(first.value)||!canCancelWithoutBids(first.value))return {ok:false as const,code:'BIDS_OR_STATE_CHANGED'};
    const url=ORIGIN+'/api/sell/v1/items/'+auctionId+'/close';
    let token:string|null=null;
    try {
      const r=await this.#fetch(url+'/preview?operation=CANCEL',{method:'GET',headers:{Cookie:this.#cookie,Accept:'application/json',Referer:ORIGIN+'/jp/auction/'+auctionId},
        redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20_000)});
      if(r.status!==200||r.redirected||!(r.headers.get('content-type')??'').startsWith('application/json')) {
        await r.body?.cancel().catch(()=>{});return {ok:false as const,code:'CANCELLATION_PREVIEW_UNAVAILABLE'};
      }
      token=r.headers.get('x-csrf-token');
      if(!token||token.length>8192||/[\r\n]/.test(token)||!zeroFeeCancellationPreview(JSON.parse(await limitedHtml(r)),first.value))
        return {ok:false as const,code:'CANCELLATION_FEE_OR_FORM_CHANGED'};
    }catch{return {ok:false as const,code:'CANCELLATION_PREVIEW_UNAVAILABLE'};}
    const fresh=await this.inspectListing(auctionId);
    if(!fresh.ok)return fresh;
    if(!matches(fresh.value)||!canCancelWithoutBids(fresh.value))return {ok:false as const,code:'BIDS_OR_STATE_CHANGED'};
    this.#cancellationAttempted=true;
    try{await beforeSend(fresh.value);}catch{return {ok:false as const,code:'ATTEMPT_NOT_RESERVED'};}
    let httpStatus:number|undefined;
    try {
      const r=await this.#fetch(url,{method:'PUT',headers:{Cookie:this.#cookie,Origin:ORIGIN,Referer:ORIGIN+'/jp/auction/'+auctionId,
        'Content-Type':'application/json',Accept:'application/json','x-csrf-token':token},body:JSON.stringify({hasCancelFee:false,operation:'CANCEL'}),
        redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20_000)});
      httpStatus=r.status; await r.body?.cancel().catch(()=>{});
    }catch{/* Reconcile the exact known ID even when acknowledgement is lost. */}
    const after=await this.inspectListing(auctionId);
    return after.ok&&matches(after.value)&&after.value.status==='cancelled'&&after.value.bids===0 ?
      {ok:true as const,value:after.value,httpStatus}:{ok:false as const,code:'CANCELLATION_RESULT_UNKNOWN',httpStatus};
  }

  /** Observed in the user-supplied HTML + uploadImage/dragdrop scripts (2026-10-16).
   * Uploads one image asset only, without a product/listing/preview submission.
   * One attempt per session even after failure; the caller must retain its result
   * and never construct another session simply to retry an uncertain upload.
   * This is an operator probe, not the production multi-image/durable job runner.
   */
  async probeImageUpload(bytes: Uint8Array, filename: string): Promise<ImageResult> {
    if (this.#imageAttempted) return { ok: false, code: "UPLOAD_ALREADY_ATTEMPTED" };
    if (!this.#imageContext || Date.now() - this.#imageContext.readAt > 5 * 60_000)
      return { ok: false, code: "INPUT_REQUIRED" };
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const png = [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b);
    if (!/^[a-zA-Z0-9_-]{1,80}\.(jpg|jpeg|png)$/.test(filename) || !bytes.length || bytes.length > 5 * 1024 * 1024 ||
        !(jpeg && /\.jpe?g$/.test(filename) || png && filename.endsWith(".png"))) return { ok: false, code: "INVALID_IMAGE" };
    const body = new FormData();
    body.append("files[0]", new Blob([Uint8Array.from(bytes)], { type: jpeg ? "image/jpeg" : "image/png" }), filename);
    body.append(".crumb", this.#imageContext.crumb);
    body.append("need_thumbnail", "1");
    this.#imageContext = null;
    this.#imageAttempted = true;
    let diagnostic: NonNullable<Extract<ImageResult, { ok: false }>["diagnostic"]> = { responseKind: "UNRECEIVED", stage: "SEND" };
    try {
      const response = await this.#fetch(ORIGIN + IMAGE_PATH, { method: "POST", body,
        headers: { Cookie: this.#cookie, Origin: ORIGIN, Referer: this.#inputUrl, Accept: "application/json" },
        cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const contentType = (response.headers.get("content-type") ?? "").split(";",1)[0].trim().toLowerCase();
      diagnostic = { status: response.status, stage: "HTTP", responseKind:
        contentType === "application/json" ? "JSON" : contentType === "text/html" ? "HTML" : "OTHER" };
      if ([401,403,429].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, code: response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "ACCESS_DENIED" : "RATE_LIMITED", diagnostic };
      }
      if (response.status !== 200 || response.redirected || contentType !== "application/json") {
        await response.body?.cancel().catch(() => {});
        return { ok: false, code: "IMAGE_RESULT_UNKNOWN", diagnostic };
      }
      diagnostic.stage = "DECODE";
      const result = JSON.parse(await limitedHtml(response));
      diagnostic.stage = "ASSET_SHAPE";
      const photo = parseYahooImageResponse(result);
      return photo ? { ok: true, value: photo } : { ok: false, code: "IMAGE_RESULT_UNKNOWN", diagnostic };
    } catch { return { ok: false, code: "IMAGE_RESULT_UNKNOWN", diagnostic }; }
  }
}

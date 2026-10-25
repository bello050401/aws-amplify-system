import "server-only";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import iconv from "iconv-lite";
import { randomUUID } from "node:crypto";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
export type FormField = { name: string; value: string; type: string; checked: boolean; options: { value: string; label: string }[] };
export type HtmlForm = { action: string; method: string; enctype: string; fields: FormField[] };
export type HtmlPage = { url: string; status: number; html: string };
export class EconveniHttpError extends Error {
  constructor(public readonly code: "AUTH_REQUIRED" | "ACCESS_DENIED" | "ADDITIONAL_AUTH" | "CONTRACT_CHANGED" | "NETWORK" | "UNSAFE_DESTINATION") { super(code); }
}
const SMART = "https://smart.e-conveni.net";
const MEMBER = "https://member.e-conveni.net";
const IMAGE = "https://img.e-conveni.net";
function allowedUrl(value: string, base = SMART): URL {
  const url = new URL(value, base);
  if (![SMART, MEMBER, IMAGE].includes(url.origin) || url.username || url.password) throw new EconveniHttpError("UNSAFE_DESTINATION");
  return url;
}
function elements(node: Node): Element[] {
  return [...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(elements) : [])];
}
function attr(node: Element, name: string): string { return node.attrs.find(a => a.name === name)?.value ?? ""; }
function hasAttr(node: Element, name: string): boolean { return node.attrs.some(a => a.name === name); }
function text(node: Node): string { return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : ""; }
export function readForms(page: HtmlPage): HtmlForm[] {
  const nodes = elements(parse(page.html, { sourceCodeLocationInfo: true }));
  // The legacy form crosses table rows. HTML parsing reparents its controls,
  // so DOM descendants alone do not represent the browser's form.elements.
  const controls = (form: Element) => {
    const start = form.sourceCodeLocation?.startTag?.endOffset ?? -1;
    const end = form.sourceCodeLocation?.endTag?.startOffset ?? page.html.toLowerCase().indexOf("</form", start);
    const id = attr(form, "id");
    return nodes.filter(n => {
      const explicitOwner = attr(n, "form");
      if (explicitOwner) return !!id && explicitOwner === id;
      const offset = n.sourceCodeLocation?.startOffset ?? -1;
      return offset >= start && offset < end;
    });
  };
  return nodes.filter(n => n.tagName === "form").map(form => ({
    action: new URL(attr(form, "action") || page.url, page.url).href,
    method: (attr(form, "method") || "GET").toUpperCase(),
    enctype: attr(form, "enctype") || "application/x-www-form-urlencoded",
    fields: controls(form).filter(n => ["input", "textarea", "select", "button"].includes(n.tagName) && attr(n, "name") && !hasAttr(n, "disabled")).map(n => {
      const options = n.tagName === "select" ? elements(n).filter(o => o.tagName === "option") : [];
      return {
        name: attr(n, "name"), type: n.tagName === "input" ? (attr(n, "type") || "text").toLowerCase() : n.tagName,
        value: n.tagName === "textarea" ? text(n) : options.length ? attr(options.find(o => hasAttr(o, "selected")) ?? options[0], "value") : attr(n, "value"),
        checked: hasAttr(n, "checked"),
        options: options.map(o => ({ value: attr(o, "value"), label: text(o).trim() })),
      };
    }),
  }));
}
function eucText(value: string): Buffer {
  const bytes = iconv.encode(value, "euc-jp");
  // Do not silently replace unsupported characters with question marks.
  if (iconv.decode(bytes, "euc-jp") !== value) throw new EconveniHttpError("CONTRACT_CHANGED");
  return bytes;
}
export function encodeForm(fields: [string, string][]): string {
  const encode = (s: string) => Array.from(eucText(s), b =>
    /[a-zA-Z0-9*._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : b === 32 ? "+" : "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  return fields.map(([k, v]) => encode(k) + "=" + encode(v)).join("&");
}

export type UploadImage = { bytes: Buffer; mimeType: "image/jpeg" | "image/png"; filename: string };
/** Encode text like the observed EUC-JP browser form; image bytes remain unchanged. */
export function multipartForm(fields: [string, string][], images: UploadImage[]) {
  const boundary = "----Bello" + randomUUID().replaceAll("-", "");
  const chunks: Buffer[] = [];
  const header = (name: string, extra = "") => {
    if (!/^[A-Za-z0-9_\[\]-]+$/.test(name)) throw new EconveniHttpError("CONTRACT_CHANGED");
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n`));
  };
  for (const [name, value] of fields) {
    header(name);
    chunks.push(Buffer.from("\r\n"), eucText(value.replace(/\r?\n/g, "\r\n")), Buffer.from("\r\n"));
  }
  images.forEach((image, index) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(image.filename) || !["image/jpeg", "image/png"].includes(image.mimeType) || !image.bytes.length) throw new EconveniHttpError("CONTRACT_CHANGED");
    header(index ? `products_image${index + 1}` : "products_image", `; filename="${image.filename}"`);
    chunks.push(Buffer.from(`Content-Type: ${image.mimeType}\r\n\r\n`), image.bytes, Buffer.from("\r\n"));
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
type Cookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expires: number };

/** Independent server session. Never reads browser cookies or exposes session material. */
export class EconveniHttpSession {
  private cookies: Cookie[] = [];
  private authenticated = false;
  private cachedRegistration: HtmlForm | null = null;
  private writeAttempted = false;
  constructor(private readonly transport: typeof fetch = fetch) {}
  private acceptCookies(headers: Headers, url: URL) {
    for (const raw of headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";").map(p => p.trim());
      const equal = pair.indexOf("=");
      if (equal < 1) continue;
      const name = pair.slice(0, equal), value = pair.slice(equal + 1);
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n;]/.test(value)) continue;
      const attrs = Object.fromEntries(attributes.map(a => { const i = a.indexOf("="); return [a.slice(0, i < 0 ? a.length : i).toLowerCase(), i < 0 ? "" : a.slice(i + 1)]; }));
      const domain = (attrs.domain || url.hostname).replace(/^\./, "").toLowerCase();
      if (!["e-conveni.net", "smart.e-conveni.net", "member.e-conveni.net", "img.e-conveni.net"].includes(domain) || !(url.hostname === domain || url.hostname.endsWith("." + domain))) continue;
      const path = attrs.path?.startsWith("/") ? attrs.path : url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/";
      const expires = /^-?\d+$/.test(attrs["max-age"] ?? "") ? Date.now() + Number(attrs["max-age"]) * 1000 : attrs.expires ? Date.parse(attrs.expires) : Infinity;
      this.cookies = this.cookies.filter(c => !(c.name === name && c.domain === domain && c.path === path));
      if (expires <= Date.now()) continue;
      this.cookies.push({ name, value, domain, path, hostOnly: !attrs.domain, secure: "secure" in attrs, expires: Number.isNaN(expires) ? Infinity : expires });
    }
  }
  private async request(path: string, method: "GET" | "POST" = "GET", body?: string | Buffer, contentType = "application/x-www-form-urlencoded"): Promise<HtmlPage> {
    let url = allowedUrl(path);
    for (let redirects = 0; redirects < 6; redirects++) {
      const cookie = this.cookies.filter(c => c.expires > Date.now() &&
        (c.hostOnly ? c.domain === url.hostname : url.hostname === c.domain || url.hostname.endsWith("." + c.domain)) &&
        (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")) &&
        (!c.secure || url.protocol === "https:")).sort((a, b) => b.path.length - a.path.length).map(c => c.name + "=" + c.value).join("; ");
      let response: Response;
      try {
        response = await this.transport(url.href, {
          method, body: method === "POST" ? body as BodyInit : undefined, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20000),
          headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { "Content-Type": contentType, Origin: SMART, Referer: SMART + (url.origin === MEMBER ? "/default.php" : "/product.php?action=product_add") } : {}) },
        });
      } catch { throw new EconveniHttpError("NETWORK"); }
      this.acceptCookies(response.headers, url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get("location");
        if (!next) throw new EconveniHttpError("CONTRACT_CHANGED");
        // Never replay a credential POST to a redirect target.
        if (method === "POST" && [307, 308].includes(response.status)) throw new EconveniHttpError("CONTRACT_CHANGED");
        url = allowedUrl(next, url.href); method = "GET"; body = undefined; continue;
      }
      if ([401, 403, 429].includes(response.status)) throw new EconveniHttpError("ACCESS_DENIED");
      if (!response.ok) throw new EconveniHttpError("NETWORK");
      const charset = /charset\s*=\s*([^;\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "euc-jp";
      if (!/^(euc-jp|utf-8|shift_jis)$/i.test(charset)) throw new EconveniHttpError("CONTRACT_CHANGED");
      const html = iconv.decode(Buffer.from(await response.arrayBuffer()), charset);
      if (/g-recaptcha|h-captcha|cf-turnstile|captcha-container|二段階認証|認証コードを入力/i.test(html)) throw new EconveniHttpError("ADDITIONAL_AUTH");
      return { status: response.status, url: url.href, html };
    }
    throw new EconveniHttpError("CONTRACT_CHANGED");
  }
  async login(credentials: { loginId: string; password: string }): Promise<void> {
    this.authenticated = false;
    this.cachedRegistration = null;
    const page = await this.request(SMART + "/default.php");
    const forms = readForms(page).filter(f => f.fields.some(x => x.name === "users_account") && f.fields.some(x => x.name === "users_passwd"));
    if (forms.length !== 1) throw new EconveniHttpError("CONTRACT_CHANGED");
    const form = forms[0], action = allowedUrl(form.action);
    if (action.origin !== MEMBER || action.pathname !== "/login.php" || action.searchParams.get("action") !== "process" || form.method !== "POST") throw new EconveniHttpError("CONTRACT_CHANGED");
    const fields: [string, string][] = form.fields.filter(f => f.type === "hidden").map(f => [f.name, f.value]);
    fields.push(["users_account", credentials.loginId], ["users_passwd", credentials.password]);
    await this.request(action.href, "POST", encodeForm(fields));
    const registration = await this.request(SMART + "/product.php?action=product_add");
    const registrationForms = readForms(registration).filter(f => f.fields.some(x => x.name === "products_name") && f.fields.some(x => x.name === "products_image"));
    if (registrationForms.length !== 1) {
      throw new EconveniHttpError("AUTH_REQUIRED");
    }
    this.authenticated = true;
    this.cachedRegistration = registrationForms[0];
  }
  async registrationForm(): Promise<HtmlForm> {
    if (!this.authenticated) throw new EconveniHttpError("AUTH_REQUIRED");
    if (this.cachedRegistration) return this.cachedRegistration;
    const page = await this.request(SMART + "/product.php?action=product_add");
    const forms = readForms(page).filter(f => f.fields.some(x => x.name === "products_name"));
    if (forms.length !== 1) { this.authenticated = false; throw new EconveniHttpError("AUTH_REQUIRED"); }
    return forms[0];
  }

  /** Read only an observed inventory URL; callers must bind it by immutable BELLO ID. */
  async productPage(url: string): Promise<HtmlPage> {
    if (!this.authenticated) throw new EconveniHttpError("AUTH_REQUIRED");
    const target = allowedUrl(url);
    if (target.origin !== SMART || target.pathname !== "/product.php" || target.searchParams.get("action") !== "product_update" || !/^\d+$/.test(target.searchParams.get("products_id") ?? "")) throw new EconveniHttpError("UNSAFE_DESTINATION");
    const page = await this.request(target.href);
    if (!readForms(page).some(f => f.fields.some(x => x.name === "products_name"))) throw new EconveniHttpError("AUTH_REQUIRED");
    return page;
  }

  /** Stage 2 only. Not exposed by a production action until durable queue/reconciliation is ready. */
  async saveTestDraft(values: Record<string, string>, images: UploadImage[]): Promise<HtmlPage> {
    if (this.writeAttempted) throw new EconveniHttpError("CONTRACT_CHANGED");
    if (!values.products_name?.startsWith("【BELLO検証・出品禁止】") || !values.bikou?.startsWith("BELLO_TEST_ONLY\nBELLO_INVENTORY_ID=qa-econveni-") || values.object !== "yes" || images.length < 1 || images.length > 10) throw new EconveniHttpError("CONTRACT_CHANGED");
    const form = await this.registrationForm();
    const target = allowedUrl(form.action);
    if (target.origin !== IMAGE || target.pathname !== "/smart/functions.php" || target.search || form.method !== "POST" || form.enctype !== "multipart/form-data" || form.fields.find(f => f.name === "action")?.value !== "product_add") throw new EconveniHttpError("CONTRACT_CHANGED");
    const editable = new Set(form.fields.filter(f => !["hidden", "file", "submit", "button"].includes(f.type)).map(f => f.name));
    if (Object.keys(values).some(k => !editable.has(k))) throw new EconveniHttpError("CONTRACT_CHANGED");
    const fields: [string, string][] = form.fields.filter(f => !["file", "submit", "button"].includes(f.type) && (!["checkbox", "radio"].includes(f.type) || f.checked || Object.hasOwn(values, f.name)))
      .map(f => [f.name, values[f.name] ?? f.value]);
    const body = multipartForm(fields, images);
    // Set BEFORE POST: a timeout or uncertain response must never trigger another write.
    this.writeAttempted = true;
    return this.request(target.href, "POST", body.body, body.contentType);
  }
}

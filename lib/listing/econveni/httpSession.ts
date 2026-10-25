import "server-only";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import iconv from "iconv-lite";
import { randomUUID, createHash } from "node:crypto";
import type {ExternalProduct,ExternalStatus} from './manualSyncModel';

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
export type FormField = { name: string; value: string; type: string; checked: boolean; options: { value: string; label: string }[] };
export type HtmlForm = { action: string; method: string; enctype: string; fields: FormField[] };
export type HtmlPage = { url: string; status: number; html: string };
export type InventoryBinding = { productId: string; url: string; operationId: string | null };
export type EconveniMarket = "YAHOO" | "MERCARI_SHOPS";
export type EconveniMarketStatus = { state: "ACTIVE" | "INACTIVE" | "EXCLUDED"; listingId: string | null; listingUrl: string | null };
export type EconveniRemoteProduct = InventoryBinding & { channels: Record<EconveniMarket, EconveniMarketStatus> };
export type EconveniCommand = { channel: EconveniMarket; operation: "PUBLISH" | "STOP"; productId: string; accountId: string; url: string; title: string; price: number };
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
/** Read only the observed standard table. Never follow its command links. */
export function externalCatalogPage(page:HtmlPage):{products:ExternalProduct[];total:number}{
 const nodes=elements(parse(page.html)),totalMatch=text(parse(page.html)).match(/検索結果\s*:\s*([\d,]+)件/);
 if(!totalMatch||!readForms(page).some(f=>f.fields.some(x=>x.name==='scop')))throw new EconveniHttpError('CONTRACT_CHANGED');
 const products:ExternalProduct[]=[];
 for(const checkbox of nodes.filter(n=>n.tagName==='input'&&attr(n,'name')==='pidlist')){
  const id=attr(checkbox,'value');let row:Node|undefined=checkbox;
  while(row&&(!('tagName'in row)||row.tagName!=='tr'))row='parentNode'in row?row.parentNode??undefined:undefined;
  const cells=row&&'childNodes'in row?row.childNodes.filter((n):n is Element=>'tagName'in n&&n.tagName==='td'):[];
  if(!/^\d{1,15}$/.test(id)||cells.length!==12||text(cells[1]).trim()!==id)throw new EconveniHttpError('CONTRACT_CHANGED');
  const titleLink=elements(cells[3]).find(n=>n.tagName==='a');if(!titleLink)throw new EconveniHttpError('CONTRACT_CHANGED');
  const target=allowedUrl(attr(titleLink,'href'),page.url);
  if(target.origin!==SMART||target.pathname!=='/product.php'||target.searchParams.get('products_id')!==id||target.searchParams.get('action')!=='product_update')throw new EconveniHttpError('CONTRACT_CHANGED');
  const markers=attr(titleLink,'title').split(/\r?\n/).filter(n=>n.startsWith('BELLO_INVENTORY_ID=')).map(n=>n.slice(19));
  if(markers.length>1)throw new EconveniHttpError('CONTRACT_CHANGED');
  const source=elements(cells[2]).find(n=>n.tagName==='img');let imageUrl:string|null=null;
  if(source&&attr(source,'src').includes('/smart/products/')){
   const u=allowedUrl(attr(source,'src'),page.url);
   if(u.origin!==IMAGE||!new RegExp('^/smart/products/\\d+/'+id+'_\\d+\\.(jpg|png)$','i').test(u.pathname)||u.search||u.hash)throw new EconveniHttpError('CONTRACT_CHANGED');imageUrl=u.href;
  }
  // A fresh HTTP session uses the compact photo-present icon. The standard UI
  // uses this account/product first-photo path. The confirmation UI additionally
  // requires successful loading of both images; a missing photo cannot be linked.
  if(!imageUrl&&source&&attr(source,'src')==='images/dot_green.gif'&&/^\d+$/.test(target.searchParams.get('users_id')??'')){
   imageUrl=IMAGE+'/smart/products/'+target.searchParams.get('users_id')+'/'+id+'_1.jpg';
  }
  const status=(index:number,market:'YAHOO'|'MERCARI_SHOPS'|'BASE'):ExternalStatus=>{
   const links=elements(cells[index]).filter(n=>n.tagName==='a'),label=(links[0]?text(links[0]):text(cells[index])).trim();
   if(!['出','未','外'].includes(label))throw new EconveniHttpError('CONTRACT_CHANGED');
   const pattern=market==='YAHOO'?/^https?:\/\/(?:auctions\.yahoo\.co\.jp|page\d*\.auctions\.yahoo\.co\.jp)\/jp\/auction\/([a-z][0-9]{8,12}|[0-9]{10})\/?$/:market==='MERCARI_SHOPS'?/^https:\/\/mercari-shops\.com\/products\/([A-Za-z0-9]+)\/?$/:/^https:\/\/[a-zA-Z0-9-]+\.base\.shop\/items\/([0-9]+)\/?$/;
   const matches=links.map(n=>attr(n,'href').match(pattern)).filter((x):x is RegExpMatchArray=>!!x);
   if(matches.length>1||label==='出'&&matches.length!==1)throw new EconveniHttpError('CONTRACT_CHANGED');
   return {state:label==='出'?'ACTIVE':label==='外'?'EXCLUDED':'INACTIVE',listingId:matches[0]?.[1]??null,listingUrl:matches[0]?.[0].replace(/^http:/,'https:')??null};
  };
  const quantity=Number(text(cells[10]).trim()),price=Number(text(cells[11]).trim().replaceAll(',',''));
  if(!Number.isSafeInteger(quantity)||quantity<0||!Number.isSafeInteger(price)||price<0)throw new EconveniHttpError('CONTRACT_CHANGED');
  products.push({productId:id,title:text(titleLink).trim(),imageUrl,quantity,price,inventoryMarker:markers[0]??null,channels:{YAHOO:status(4,'YAHOO'),MERCARI_SHOPS:status(7,'MERCARI_SHOPS'),BASE:status(9,'BASE')}});
 }
 if(new Set(products.map(p=>p.productId)).size!==products.length)throw new EconveniHttpError('CONTRACT_CHANGED');
 return {products,total:Number(totalMatch[1].replaceAll(',',''))};
}
export function inventoryBindings(page: HtmlPage, inventoryId: string): InventoryBinding[] {
  const matches = new Map<string, InventoryBinding>();
  for (const node of elements(parse(page.html))) {
    if (node.tagName !== "a") continue;
    const notes = attr(node, "title").replace(/\r\n/g, "\n").split("\n");
    if (!notes.includes("BELLO_INVENTORY_ID=" + inventoryId)) continue;
    const target = allowedUrl(attr(node, "href"), page.url);
    const productId = target.searchParams.get("products_id") ?? "";
    if (target.origin !== SMART || target.pathname !== "/product.php" || target.searchParams.get("action") !== "product_update" || !/^\d+$/.test(productId)) throw new EconveniHttpError("CONTRACT_CHANGED");
    const operationId = notes.find(n => n.startsWith("BELLO_OPERATION_ID="))?.slice("BELLO_OPERATION_ID=".length) ?? null;
    matches.set(productId, { productId, url: target.href, operationId });
  }
  return [...matches.values()];
}
/** Inspect only the row bound to the immutable inventory marker, never a title match. */
export function remoteProduct(page: HtmlPage, inventoryId: string): EconveniRemoteProduct | null {
  const bindings = inventoryBindings(page, inventoryId);
  if (bindings.length > 1) throw new EconveniHttpError("CONTRACT_CHANGED");
  if (!bindings.length) return null;
  const binding = bindings[0];
  const checkbox = elements(parse(page.html)).find(n => n.tagName === "input" && attr(n,"name") === "pidlist" && attr(n,"value") === binding.productId);
  let row: Node | undefined = checkbox;
  while (row && (!("tagName" in row) || row.tagName !== "tr")) row = "parentNode" in row ? row.parentNode ?? undefined : undefined;
  if (!row || !("childNodes" in row)) throw new EconveniHttpError("CONTRACT_CHANGED");
  const cells = row.childNodes.filter((n): n is Element=>"tagName" in n && n.tagName === "td");
  if (cells.length !== 12 || text(cells[1]).trim() !== binding.productId) throw new EconveniHttpError("CONTRACT_CHANGED");
  const channel = (market: EconveniMarket): EconveniMarketStatus => {
    const cell=cells[market === "YAHOO" ? 4 : 7];
    const links=elements(cell).filter(n=>n.tagName === "a");
    const status = links.length ? text(links[0]).trim() : text(cell).trim();
    if (!["出","未","外"].includes(status)) throw new EconveniHttpError("CONTRACT_CHANGED");
    const external = links.map(n=>attr(n,"href")).filter(h=>market === "YAHOO" ? /^https?:\/\/(?:auctions\.yahoo\.co\.jp|page\d*\.auctions\.yahoo\.co\.jp)\/jp\/auction\/(?:[a-z][0-9]{8,12}|[0-9]{10})\/?$/.test(h) : /^https:\/\/mercari-shops\.com\/products\/[A-Za-z0-9]+\/?$/.test(h));
    if (external.length > 1 || status === "出" && external.length !== 1) throw new EconveniHttpError("CONTRACT_CHANGED");
    const id = external[0]?.split("/").filter(Boolean).at(-1) ?? null;
    return { state: status === "出" ? "ACTIVE" : status === "外" ? "EXCLUDED" : "INACTIVE", listingId: id,
      listingUrl: id ? market === "YAHOO" ? `https://auctions.yahoo.co.jp/jp/auction/${id}` : `https://jp.mercari.com/shops/product/${id}` : null };
  };
  return { ...binding, channels: { YAHOO: channel("YAHOO"), MERCARI_SHOPS: channel("MERCARI_SHOPS") } };
}
/** Only the four observed one-product normal UI actions are allowed. No JS is executed. */
export function readEconveniCommand(page: HtmlPage, expected: { channel: EconveniMarket; operation: "PUBLISH" | "STOP"; productId: string; accountId: string; title: string; price: number }, listDisplay = {title:expected.title,price:expected.price}): EconveniCommand {
  const labels = { YAHOO: { PUBLISH: "Yahoo!オークションガイドラインに同意して出品する", STOP: "上記のYahoo!アイテムを全て終了する" }, MERCARI_SHOPS: { PUBLISH: "メルカリShops 出品実行", STOP: "上記のメルカリShopsアイテムを全て終了する" } };
  const nodes = elements(parse(page.html));
  const buttons = nodes.filter(n => ["input","button"].includes(n.tagName) && (attr(n,"value") || text(n)).trim() === labels[expected.channel][expected.operation]);
  if (buttons.length !== 1) throw new EconveniHttpError("CONTRACT_CHANGED");
  const command = /^window\.open\('([^']+)',/.exec(attr(buttons[0],"onclick"));
  if (!command) throw new EconveniHttpError("CONTRACT_CHANGED");
  const url = allowedUrl(command[1],page.url);
  const path = expected.channel === "YAHOO" ? expected.operation === "PUBLISH" ? "/yahoo_submit.php" : "/yahoo_cancel.php" : expected.operation === "PUBLISH" ? "/exhibit/mercariShopsCreateProduct.php" : "/exhibit/mercariShopsDeleteProductInput.php";
  const allowedParams = new Set(["action","users_id","products_id","mode","order_by","attribute_page","query"]);
  if (url.origin !== (expected.channel === "YAHOO" ? SMART : IMAGE) || url.pathname !== path ||
      [...url.searchParams.keys()].some(k=>!allowedParams.has(k) || url.searchParams.getAll(k).length!==1) ||
      url.searchParams.get("products_id") !== "T"+expected.productId || url.searchParams.get("users_id") !== expected.accountId ||
      expected.channel === "YAHOO" && url.searchParams.get("action") !== "exhibit_product") throw new EconveniHttpError("CONTRACT_CHANGED");
  const expectedText = listDisplay.title + " @" + listDisplay.price.toLocaleString("en-US") + "円";
  const normalized = text(parse(page.html)).replace(/\s+/g," ");
  // Exactly one preview line: refuse a batch that accidentally contains another product.
  if (!normalized.includes(expectedText) || (normalized.match(/@[\d,]+円/g) ?? []).length !== 1) throw new EconveniHttpError("CONTRACT_CHANGED");
  return { ...expected, url: url.href };
}

/** The batch confirmation always displays the base title/price, even for Shops.
 * Validate the channel-specific values from this exact product before using that label. */
export function readEconveniPreviewProduct(page:HtmlPage, expected:Omit<EconveniCommand,'url'>){
  const forms=readForms(page).filter(f=>f.fields.some(x=>x.name==='products_name'));
  if(forms.length!==1)throw new EconveniHttpError('CONTRACT_CHANGED');
  const values=Object.fromEntries(formValues(forms[0]));
  const title=expected.channel==='MERCARI_SHOPS'?values.mercariShops_name:values.products_name;
  const price=expected.channel==='MERCARI_SHOPS'?values.mercariShops_price:values.products_price;
  if(values.products_id!==expected.productId||values.users_id!==expected.accountId||title!==expected.title||!/^\d+$/.test(price??'')||Number(price)!==expected.price||!values.products_name||!/^\d+$/.test(values.products_price??''))throw new EconveniHttpError('CONTRACT_CHANGED');
  return {title:values.products_name,price:Number(values.products_price)};
}

export function econveniCommandCompleted(page: HtmlPage, channel: EconveniMarket, operation: "PUBLISH" | "STOP") {
  const visible = text(parse(page.html)).replace(/\s+/g," ");
  return visible.includes("システム正常終了") && !/エラー|失敗|アクセス拒否|ログインしてください/.test(visible) &&
    (operation === "PUBLISH" ? visible.includes("出品完了") : visible.includes("完了")) &&
    (channel !== "MERCARI_SHOPS" || /処理件数\s*1件/.test(visible));
}
/** Browser successful-controls semantics, including exactly one checked radio per name. */
export function formValues(form: HtmlForm, overrides: Record<string,string> = {}): [string,string][] {
  const fields = form.fields.filter(f=>!["file","submit","button","image","reset"].includes(f.type));
  const names = new Set(fields.map(f=>f.name));
  if (Object.keys(overrides).some(k=>!names.has(k))) throw new EconveniHttpError("CONTRACT_CHANGED");
  const output: [string,string][]=[];
  const consumed=new Set<string>();
  for(const field of fields) {
    if(Object.hasOwn(overrides,field.name)) {
      if(consumed.has(field.name)) continue;
      consumed.add(field.name);
      const value=overrides[field.name];
      if(field.type==="checkbox" && value==="") continue;
      if(field.type==="radio" && !fields.some(f=>f.name===field.name&&f.value===value)) throw new EconveniHttpError("CONTRACT_CHANGED");
      if(field.options.length && !field.options.some(o=>o.value===value)) throw new EconveniHttpError("CONTRACT_CHANGED");
      output.push([field.name,value]);
    } else if(!["checkbox","radio"].includes(field.type)||field.checked) output.push([field.name,field.value]);
  }
  return output;
}

/** Exact successful-control comparison also rejects unexpected enabled checkboxes. */
export function sameOptionValues(actual: [string,string][], expected: [string,string][], ignored: string[]): boolean {
  const normalize=(values:[string,string][])=>values.filter(([name])=>!ignored.includes(name))
    .map(([name,value])=>JSON.stringify([name,value])).sort();
  return JSON.stringify(normalize(actual))===JSON.stringify(normalize(expected));
}

export function productImageUrls(page:HtmlPage, productId:string):string[] {
  if(!/^\d+$/.test(productId)) throw new EconveniHttpError("CONTRACT_CHANGED");
  const paths=new Map<number,string>();
  for(const image of elements(parse(page.html)).filter(e=>e.tagName==="img")) {
    const source=attr(image,"src");
    if(!source.includes("/smart/products/")) continue;
    const url=allowedUrl(source,page.url);
    const match=/^\/smart\/products\/(\d+)\/(\d+)_(\d+)\.(jpg|png)$/i.exec(url.pathname);
    if(url.origin!==IMAGE||!match||match[2]!==productId||url.search||url.hash) throw new EconveniHttpError("CONTRACT_CHANGED");
    const order=Number(match[3]);
    if(order<1||order>20||paths.has(order)&&paths.get(order)!==url.href) throw new EconveniHttpError("CONTRACT_CHANGED");
    paths.set(order,url.href);
  }
  return [...paths].sort(([a],[b])=>a-b).map(([,url])=>url);
}
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
  private executedCommands = new Set<string>();
  private optionWriteAttempted=false;

  dispose() {
    this.cookies = [];
    this.authenticated = false;
    this.cachedRegistration = null;
  }
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

  async searchInventoryPage(inventoryId: string): Promise<HtmlPage> {
    if (!this.authenticated) throw new EconveniHttpError("AUTH_REQUIRED");
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(inventoryId)) throw new EconveniHttpError("CONTRACT_CHANGED");
    const query = new URLSearchParams({ scop: "bikou", query: "BELLO_INVENTORY_ID=" + inventoryId, radioquery: "and" });
    const page = await this.request(SMART + "/products.php?" + query);
    if (!readForms(page).some(f => f.fields.some(x => x.name === "scop"))) throw new EconveniHttpError("AUTH_REQUIRED");
    return page;
  }
  async findInventory(inventoryId: string): Promise<InventoryBinding[]> {
    const page = await this.searchInventoryPage(inventoryId);
    const matches = inventoryBindings(page, inventoryId);
    // Search is substring-based on the service. Only an exact, line-delimited internal ID binds.
    if (matches.length > 1) throw new EconveniHttpError("CONTRACT_CHANGED");
    return matches;
  }

  async readInventory(inventoryId: string) { return remoteProduct(await this.searchInventoryPage(inventoryId), inventoryId); }

  async readExternalCatalog():Promise<ExternalProduct[]>{
    if(!this.authenticated)throw new EconveniHttpError('AUTH_REQUIRED');
    const items:ExternalProduct[]=[];let total:number|undefined;
    for(let page=1;page<=40;page++){
      if(page>1)await new Promise(r=>setTimeout(r,1000));
      const result=externalCatalogPage(await this.request(SMART+'/products.php?'+new URLSearchParams({order_by:'products_id',attribute_page:String(page)})));
      if(total!==undefined&&result.total!==total||result.total>1000)throw new EconveniHttpError('CONTRACT_CHANGED');
      total=result.total;items.push(...result.products);
      if(new Set(items.map(p=>p.productId)).size!==items.length||items.length>total)throw new EconveniHttpError('CONTRACT_CHANGED');
      if(items.length===total)return items;
      if(!result.products.length)throw new EconveniHttpError('CONTRACT_CHANGED');
    }
    throw new EconveniHttpError('CONTRACT_CHANGED');
  }

  async preflightSave(inventoryId:string,values:Record<string,string>,count:number){
    const existing=await this.readInventory(inventoryId);
    const form=existing?readForms(await this.productPage(existing.url)).find(f=>f.fields.some(x=>x.name==='products_name')):await this.registrationForm();
    if(!form||count<1||count>10)throw new EconveniHttpError('CONTRACT_CHANGED');
    // Validate field choices and encoding before reserving an external write.
    for(const [key,value] of formValues(form,values)){eucText(key);eucText(value);}
  }

  /** Unbound legacy products must not be duplicated or adopted by title alone. */
  async assertNoExistingTitle(title:string){
    const page=await this.request(SMART+'/products.php?'+encodeForm([['scop','products_name'],['query',title],['radioquery','and']]));
    if(!readForms(page).some(f=>f.fields.some(x=>x.name==='scop')))throw new EconveniHttpError('AUTH_REQUIRED');
    if(elements(parse(page.html)).some(n=>n.tagName==='input'&&attr(n,'name')==='pidlist'))throw new EconveniHttpError('CONTRACT_CHANGED');
  }

  async verifySavedProduct(binding:InventoryBinding, expected:{fields:Record<string,string>;imageHashes:string[]}):Promise<boolean> {
    const page=await this.productPage(binding.url);
    const forms=readForms(page).filter(f=>f.fields.some(x=>x.name==="products_name"));
    if(forms.length!==1) throw new EconveniHttpError("CONTRACT_CHANGED");
    const actual=Object.fromEntries(formValues(forms[0]));
    const normalize=(s:string)=>s.replace(/\r\n/g,"\n");
    if(Object.entries(expected.fields).some(([key,value])=>normalize(actual[key]??"")!==normalize(value))) return false;
    const urls=productImageUrls(page,binding.productId);
    if(urls.length!==expected.imageHashes.length) return false;
    for(let index=0;index<urls.length;index++){
      let response:Response;
      try{response=await this.transport(urls[index],{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15_000)});}
      catch{throw new EconveniHttpError("NETWORK");}
      if(!response.ok||!response.body) throw new EconveniHttpError("NETWORK");
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(size>20*1024*1024) throw new EconveniHttpError("CONTRACT_CHANGED");chunks.push(part.value);
      }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")!==expected.imageHashes[index])return false;
    }
    return true;
  }

  /** Read normal option labels without touching login/token settings on the same page. */
  async yahooOptionForm(label: string): Promise<{form:HtmlForm; labels:{value:string;label:string}[]}> {
    if(!this.authenticated) throw new EconveniHttpError("AUTH_REQUIRED");
    if(!/^(?:add|[1-9]\d*)$/.test(label)) throw new EconveniHttpError("CONTRACT_CHANGED");
    const page=await this.request(SMART+"/yahoo_setting.php?label="+label);
    const forms=readForms(page);
    const matching=forms.filter(f=>f.fields.some(x=>x.name==="Duration")&&f.fields.some(x=>x.name==="istatus"));
    if(matching.length!==1) throw new EconveniHttpError("CONTRACT_CHANGED");
    const form=matching[0];
    if(form.action!==SMART+"/yahoo_setting.php"||form.method!=="POST"||form.fields.some(f=>/passwd|password|token/i.test(f.name))) throw new EconveniHttpError("CONTRACT_CHANGED");
    const selector=elements(parse(page.html)).find(n=>n.tagName==="select"&&attr(n,"name")==="selected");
    if(!selector) throw new EconveniHttpError("CONTRACT_CHANGED");
    const labels=elements(selector).filter(n=>n.tagName==="option").map(n=>({value:attr(n,"value"),label:text(n).trim()}));
    return {form,labels};
  }

  /** Copy a normal option template into an immutable BELLO-owned label.
   * Existing labels are never edited: they may be shared by unrelated products.
   * The caller holds the durable account lease and has reserved SAVE first.
   */
  async ensureYahooOption(templateId:string, options:{condition:string;duration:number;closingHour:number;autoExtension:boolean}):Promise<string> {
    if(!["new","used10","used20","used40","used60","used80"].includes(options.condition)||!Number.isInteger(options.duration)||options.duration<1||options.duration>8||!Number.isInteger(options.closingHour)||options.closingHour<0||options.closingHour>23) throw new EconveniHttpError("CONTRACT_CHANGED");
    const source=await this.yahooOptionForm(templateId);
    const base=Object.fromEntries(formValues(source.form));
    // Never inherit paid promotions or automatic price reductions.
    if(["showCase1","boldSelected","highlightlistingSelected","giftSelected","wrappingSelected","affiliate","change_price_resubmit"].some(k=>base[k]&&base[k]!=="0")||Number(base.featuredAmount??0)>0) throw new EconveniHttpError("CONTRACT_CHANGED");
    const replacements={istatus:options.condition,Duration:String(options.duration),ClosingTime:String(options.closingHour),AutoExtension:options.autoExtension?"yes":"",rest_key:"on",numResubmit:"0"};
    const effective=formValues(source.form,replacements).filter(([k])=>!["yahoo_setting_id","users_id","sort_order","yahoo_setting_label"].includes(k));
    const label="BELLO-"+createHash("sha256").update(JSON.stringify(effective)).digest("hex").slice(0,24);
    const found=source.labels.filter(l=>l.label===label);
    if(found.length>1) throw new EconveniHttpError("CONTRACT_CHANGED");
    const verify=async(id:string)=>{
      const actual=formValues((await this.yahooOptionForm(id)).form);
      const read=Object.fromEntries(actual);
      if(read.yahoo_setting_label!==label||!sameOptionValues(actual,effective,["yahoo_setting_id","users_id","sort_order","yahoo_setting_label"])) throw new EconveniHttpError("CONTRACT_CHANGED");
      return id;
    };
    if(found.length) return verify(found[0].value);
    if(this.optionWriteAttempted) throw new EconveniHttpError("CONTRACT_CHANGED");
    const blank=(await this.yahooOptionForm("add")).form;
    const fresh=Object.fromEntries(formValues(blank));
    if(fresh.yahoo_setting_id!=="add"||fresh.users_id!==base.users_id) throw new EconveniHttpError("CONTRACT_CHANGED");
    const fields:[string,string][]=[...effective,["yahoo_setting_label",label],["yahoo_setting_id","add"],["users_id",fresh.users_id],["sort_order",fresh.sort_order]];
    this.optionWriteAttempted=true;
    this.cachedRegistration=null;
    await this.request(blank.action,"POST",encodeForm(fields));
    const after=await this.yahooOptionForm("add");
    const matches=after.labels.filter(l=>l.label===label);
    if(matches.length!==1) throw new EconveniHttpError("CONTRACT_CHANGED");
    return verify(matches[0].value);
  }

  /** Normal product form. Only the bound inventory can be updated; unknown writes are never replayed. */
  async saveProduct(inventoryId:string,operationId:string,values:Record<string,string>,images:UploadImage[],existing:InventoryBinding|null):Promise<HtmlPage> {
    if(this.writeAttempted||!/^[a-zA-Z0-9-]{8,80}$/.test(inventoryId)||!/^[a-zA-Z0-9-]{8,80}$/.test(operationId)||images.length>10) throw new EconveniHttpError("CONTRACT_CHANGED");
    if(!values.products_name?.trim()||!images.length&&!existing||Object.hasOwn(values,"bikou")) throw new EconveniHttpError("CONTRACT_CHANGED");
    let form:HtmlForm;
    if(existing){
      const binding=(await this.findInventory(inventoryId))[0];
      if(!binding||binding.productId!==existing.productId) throw new EconveniHttpError("CONTRACT_CHANGED");
      const page=await this.productPage(binding.url);
      const forms=readForms(page).filter(f=>f.fields.some(x=>x.name==="products_name"));
      if(forms.length!==1) throw new EconveniHttpError("CONTRACT_CHANGED");
      form=forms[0];
    } else {
      if((await this.findInventory(inventoryId)).length) throw new EconveniHttpError("CONTRACT_CHANGED");
      form=await this.registrationForm();
    }
    const target=allowedUrl(form.action);
    const expectedAction=existing?"product_update":"product_add";
    if(target.origin!==IMAGE||target.pathname!=="/smart/functions.php"||target.search||form.method!=="POST"||form.enctype!=="multipart/form-data"||form.fields.find(f=>f.name==="action")?.value!==expectedAction) throw new EconveniHttpError("CONTRACT_CHANGED");
    if(existing&&form.fields.find(f=>f.name==="products_id")?.value!==existing.productId) throw new EconveniHttpError("CONTRACT_CHANGED");
    const editable=new Set(form.fields.filter(f=>!["hidden","file","submit","button","image"].includes(f.type)).map(f=>f.name));
    if(Object.keys(values).some(k=>!editable.has(k))) throw new EconveniHttpError("CONTRACT_CHANGED");
    const previousNotes=form.fields.find(f=>f.name==="bikou")?.value??"";
    const notes=[...previousNotes.replace(/\r\n/g,"\n").split("\n").filter(n=>n&&!/^BELLO_(?:INVENTORY_ID|OPERATION_ID)=/.test(n)),"BELLO_INVENTORY_ID="+inventoryId,"BELLO_OPERATION_ID="+operationId].join("\n");
    const fields=formValues(form,{...values,bikou:notes});
    const body=multipartForm(fields,images);
    this.writeAttempted=true;
    const result=await this.request(target.href,"POST",body.body,body.contentType);
    if(existing&&images.length){
      const saved=await this.readInventory(inventoryId);
      if(saved?.productId!==existing.productId||saved.operationId!==operationId)throw new EconveniHttpError('CONTRACT_CHANGED');
      const page=await this.productPage(saved.url);
      // The form update leaves trailing files behind. Remove only observed image controls
      // outside the selected range, on this exact product, after its save is acknowledged.
      const extra=elements(parse(page.html)).filter(n=>n.tagName==='input'&&/^画像\d+を削除$/.test(attr(n,'value')))
        .map(n=>({node:n,index:Number(attr(n,'value').match(/\d+/)![0])})).filter(x=>x.index>images.length).sort((a,b)=>b.index-a.index);
      const accountId=form.fields.find(f=>f.name==='users_id')?.value;
      for(const {node,index} of extra){
        const match=/^location\.href='([^']+)'$/.exec(attr(node,'onclick'));
        if(!match||index>20)throw new EconveniHttpError('CONTRACT_CHANGED');
        const deletion=allowedUrl(match[1]),suffix=index===1?'':String(index),key='products_image'+suffix;
        if(deletion.origin!==IMAGE||deletion.pathname!=='/smart/functions.php'||deletion.searchParams.get('action')!=='delete_image'+suffix||deletion.searchParams.get('users_id')!==accountId||deletion.searchParams.get('products_id')!==existing.productId||![existing.productId+'_'+index+'.jpg',existing.productId+'_'+index+'.png'].includes(deletion.searchParams.get(key)??'')||[...deletion.searchParams.keys()].some(k=>!['action','users_id','products_id',key].includes(k)))throw new EconveniHttpError('CONTRACT_CHANGED');
        await this.request(deletion.href);
      }
    }
    return result;
  }

  /** Preview is read-only. Execution requires its exact observed command and a durable reservation. */
  async publicationPreview(expected: Omit<EconveniCommand,"url"|"accountId">): Promise<EconveniCommand> {
    if (!/^\d+$/.test(expected.productId)) throw new EconveniHttpError("CONTRACT_CHANGED");
    const form = await this.registrationForm();
    const accountId = form.fields.find(f=>f.name === "users_id")?.value ?? "";
    if (!/^\d+$/.test(accountId)) throw new EconveniHttpError("AUTH_REQUIRED");
    const detail=await this.productPage(SMART+'/product.php?'+new URLSearchParams({action:'product_update',products_id:expected.productId}));
    const listDisplay=readEconveniPreviewProduct(detail,{...expected,accountId});
    const action = (expected.channel === "YAHOO" ? "yahoo" : "mercariShops") + (expected.operation === "PUBLISH" ? "_exhibit_together" : "_stop_together");
    const page = await this.request(SMART + "/product_listing.php?" + new URLSearchParams({ action, products_id: "T"+expected.productId, mode:"", order_by:"", attribute_page:"", query:"" }));
    return readEconveniCommand(page, { ...expected, accountId },listDisplay);
  }
  async executeCommand(command: EconveniCommand): Promise<HtmlPage> {
    if (!this.authenticated) throw new EconveniHttpError("AUTH_REQUIRED");
    const key=command.channel+":"+command.operation+":"+command.productId;
    if (this.executedCommands.has(key)) throw new EconveniHttpError("CONTRACT_CHANGED");
    // Validate again against the normal preview, not an arbitrary URL supplied by a caller.
    const fresh=await this.publicationPreview(command);
    if (fresh.url!==command.url) throw new EconveniHttpError("CONTRACT_CHANGED");
    this.executedCommands.add(key);
    return this.request(fresh.url);
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

import "server-only";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { publicationFields } from "./publicationFields";
import { verifyPreview, type YahooFixedPreviewInput, type YahooPreviewImages } from "./webHttpPreview";

export const PUBLICATION_URL = "https://auctions.yahoo.co.jp/sell/jp/config/submit";
type Node = DefaultTreeAdapterMap["node"];
type El = DefaultTreeAdapterMap["element"];
const attr = (el: El, key: string) => el.attrs.find(a => a.name === key)?.value;
function nodes(root: Node): El[] {
  const pending = [root], found: El[] = [];
  let count = 0;
  while (pending.length) {
    const n = pending.pop()!;
    if (++count > 30_000) throw Error("DOCUMENT_LIMIT");
    if ("tagName" in n) found.push(n);
    if ("childNodes" in n) pending.push(...n.childNodes);
  }
  return found;
}

/** Serializes only a fresh, verified confirmation. The observed configSubmit
 * handler sets this exact action and submits the hidden form unchanged when
 * premium enrollment and draft saving are absent. Never executes website JS. */
export function publicationRequest(html: string, input: YahooFixedPreviewInput, image: YahooPreviewImages): URLSearchParams {
  if (!verifyPreview(html, input, image)) throw Error("PREVIEW_MISMATCH");
  const all = nodes(parse(html));
  const buttons = all.filter(n => n.tagName === "button" && attr(n, "id") === "auc_preview_submit_down");
  if (buttons.length !== 1 || attr(buttons[0], "disabled") !== undefined ||
      attr(buttons[0], "onclick") !== `auc_submitpreview_disabled();configSubmit(document.auction, '${PUBLICATION_URL}', 'UTF-8');`)
    throw Error("PUBLICATION_ACTION_CHANGED");
  const form = all.find(n => n.tagName === "form" && attr(n, "name") === "auction")!;
  const body = new URLSearchParams();
  const allowed=new Set(publicationFields);
  // Fresh multi-image preview uses the same numbered fields; all values are
  // checked against the requested assets by verifyPreview above.
  for(let i=2;i<=10;i++)for(const prefix of ['ImageFullPath','ImageWidth','ImageHeight'])allowed.add(prefix+i);
  // Observed oresubmit preview on 2026-10-17 adds these existing-image fields.
  if(input.relistId){allowed.add('aID');for(let i=1;i<=10;i++)allowed.add(`Image${i}Uploaded`);}
  for (const n of nodes(form)) {
    if (!["input", "select", "textarea", "button"].includes(n.tagName) || attr(n,"disabled") !== undefined) continue;
    const name = attr(n, "name");
    if (!name) continue;
    if (n.tagName !== "input" || attr(n, "type") !== "hidden" || !allowed.has(name) || body.has(name))
      throw Error("PUBLICATION_FORM_CHANGED");
    const value = attr(n, "value") ?? "";
    if (value.length > 60_000) throw Error("FIELD_LIMIT");
    body.set(name, value);
  }
  if (body.get("mode") !== (input.relistId ? "oresubmit" : "submit") || (body.get("aID") ?? "") !== (input.relistId ?? "") || body.get("comefrprv") !== "1" ||
      !body.get(".crumb") || !body.get("md5")) throw Error("PUBLICATION_FORM_CHANGED");
  for (const [key, value] of body) {
    if (/Charge|Fee|ReservePrice|charityOption|affiliateRate/.test(key) && value && !/^0(?:\.0+)?$/.test(value))
      throw Error("UNAPPROVED_OPTION");
  }
  return body;
}

/** Safe structural evidence for an operator's first observed response. A 200
 * or candidate link is not treated as proof of publication. No HTML/tokens are
 * returned. Readback of the exact listing is mandatory before reporting success. */
export function publicationResponseEvidence(html: string) {
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw Error("DOCUMENT_LIMIT");
  const all = nodes(parse(html));
  const ids = new Set<string>();
  for (const n of all.filter(n => n.tagName === "a")) {
    try {
      const u = new URL(attr(n,"href") ?? "", "https://auctions.yahoo.co.jp");
      const match = u.pathname.match(/^\/jp\/auction\/([a-z][0-9]{8,12})$/);
      if (u.origin === "https://auctions.yahoo.co.jp" && !u.username && !u.password && match) ids.add(match[1]);
    } catch {}
  }
  const text = (n: Node): string => {
    if ("tagName" in n && ["script", "style", "noscript", "input"].includes(n.tagName)) return "";
    if ("value" in n && n.nodeName === "#text") return n.value;
    return "childNodes" in n ? n.childNodes.map(text).join(" ") : "";
  };
  const visible = text(parse(html));
  return { candidateAuctionIds: [...ids].slice(0,20),
    completionMessagePresent: /出品(?:が|は)?(?:完了しました|しました)|出品を受け付けました/.test(visible),
    loginRequired: /ログインしてください/.test(visible),
    errorPresent: /エラー|出品できません|時間をおいて/.test(visible) };
}

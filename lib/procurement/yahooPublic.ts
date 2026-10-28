import { parse } from "parse5";
import { auctionIdValid } from "./yahoo";
type Node = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
};
const nodes = (n: Node): Node[] => [n, ...(n.childNodes || []).flatMap(nodes)];
const attr = (n: Node, k: string) =>
  n.attrs?.find((a) => a.name === k)?.value || "";
const text = (n: Node): string =>
  n.value ?? (n.childNodes || []).map(text).join("");
export type YahooStore = {
  name: string;
  address: string;
  license: string;
  url: string;
};
export type YahooPublicItem = {
  imageUrl: string;
  name: string;
  date: string;
  storeUrl: string | null;
};
export function validYahooImage(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.hostname === "auctions.c.yimg.jp" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      u.pathname.startsWith("/images.auctions.yahoo.co.jp/image/") &&
      /\.(jpe?g|png|webp)$/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}
export function validYahooStore(value: string) {
  try {
    const u = new URL(value);
    return (
      u.origin === "https://auctions.yahoo.co.jp" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      /^\/html\/profile\/[A-Za-z0-9_-]{10,80}\.html$/.test(u.pathname) &&
      u.search === "?user_type=c"
    );
  } catch {
    return false;
  }
}
export function parseYahooPublicItem(
  html: string,
  id: string,
): YahooPublicItem {
  if (!auctionIdValid(id)) throw Error("商品IDが不正です。");
  const all = nodes(parse(html)),
    products = all
      .filter(
        (n) =>
          n.tagName === "script" && attr(n, "type") === "application/ld+json",
      )
      .flatMap((n) => {
        try {
          const j = JSON.parse(text(n));
          return j["@type"] === "Product" ? [j] : [];
        } catch {
          return [];
        }
      })
      .filter(
        (p) =>
          p.url === `https://auctions.yahoo.co.jp/jp/auction/${id}` ||
          p.url === `https://auctions.yahoo.co.jp/auction/${id}`,
      );
  if (products.length !== 1)
    throw Error("ヤフオクの商品ページを確認できません。");
  const p = products[0],
    imageUrl = Array.isArray(p.image) ? p.image[0] : p.image;
  if (typeof imageUrl !== "string" || !validYahooImage(imageUrl))
    throw Error("ヤフオクの先頭の写真を取得できません。");
  const stores = [
    ...new Set(
      all
        .filter((n) => n.tagName === "a")
        .map((n) => attr(n, "href"))
        .filter(validYahooStore),
    ),
  ];
  if (stores.length > 1) throw Error("ストア情報を特定できません。");
  const end = String(p.offers?.priceValidUntil || "");
  return {
    imageUrl,
    name: String(p.name || ""),
    date: /^\d{4}-\d{2}-\d{2}T/.test(end) ? end.slice(0, 10) : "",
    storeUrl: stores[0] || null,
  };
}
export function parseYahooStore(html: string, url: string): YahooStore {
  if (!validYahooStore(url)) throw Error("ストア情報のURLが不正です。");
  const all = nodes(parse(html));
  const values = (label: string) =>
    all
      .filter((n) => n.tagName === "tr")
      .flatMap((n) => {
        const cells = (n.childNodes || []).filter(
          (n) => n.tagName === "td" || n.tagName === "th",
        );
        return cells.length === 2 && text(cells[0]).trim() === label
          ? [text(cells[1]).replace(/\s+/g, " ").trim()]
          : [];
      });
  const names = values("会社名"),
    addresses = values("本店住所");
  if (
    names.length !== 1 ||
    addresses.length !== 1 ||
    !names[0] ||
    !addresses[0]
  )
    throw Error("ストアの会社名・本店住所を確認できません。");
  return {
    name: names[0],
    address: addresses[0],
    license: values("免許情報")[0] || "",
    url,
  };
}
async function bytes(url: string, max: number) {
  const r = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!r.ok || !r.body)
    throw Error("ヤフオクの写真・ストア情報の取得に失敗しました。");
  const reader = r.body.getReader(),
    parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw Error("取得データが大きすぎます。");
      parts.push(value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function yahooPublicItem(id: string) {
  if (!auctionIdValid(id)) throw Error("商品IDが不正です。");
  return parseYahooPublicItem(
    (
      await bytes(
        `https://auctions.yahoo.co.jp/jp/auction/${id}`,
        2 * 1024 * 1024,
      )
    ).toString("utf8"),
    id,
  );
}
export async function yahooStore(url: string) {
  if (!validYahooStore(url)) throw Error("ストア情報を確認できません。");
  return parseYahooStore((await bytes(url, 1024 * 1024)).toString("utf8"), url);
}
export async function yahooImage(url: string) {
  if (!validYahooImage(url)) throw Error("写真のURLが不正です。");
  const data = await bytes(url, 25 * 1024 * 1024);
  const mime = data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    ? "image/jpeg"
    : data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : data.subarray(0, 4).toString() === "RIFF" &&
          data.subarray(8, 12).toString() === "WEBP"
        ? "image/webp"
        : null;
  if (!mime) throw Error("写真の形式を確認できません。");
  return { bytes: data, mime };
}

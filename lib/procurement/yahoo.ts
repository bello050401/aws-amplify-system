import { createHash } from "node:crypto";
import { mailText, type PurchaseMail } from "../saleCandidates/mailParser";

export type YahooPurchase = {
  auctionId: string;
  name: string;
  date: string;
  quantity: number;
  itemTotal: number;
  shipping: number | null;
  orderTotal: number | null;
  orderId: string;
  store: boolean;
  receivedAt: string;
  mailId: string;
  changed: boolean;
  warnings: string[];
};
export type YahooPurchaseEvent = {
  kind: "WON" | "ORDER" | "CHANGE";
  orderId: string;
  auctionIds: string[];
  at: string;
  lots: YahooPurchase[];
};
export const auctionIdValid = (id: string) =>
  /^(?:[a-z]\d{6,15}|\d{9,15})$/.test(id);
export const yahooPurchaseId = (id: string) => {
  if (!auctionIdValid(id)) throw Error("商品IDが不正です。");
  const h = createHash("sha256")
    .update("BELLO:YAHOO:PURCHASE:" + id)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const field = (s: string, label: string) =>
  s
    .match(
      new RegExp("(?:^|\\n)[ \\t]*" + label + "[ \\t]*:[ \\t]*([^\\n]+)"),
    )?.[1]
    ?.trim() || "";
const amount = (s: string) => {
  const n = s.replace(/[¥円,\s]/g, "");
  return /^\d+$/.test(n) &&
    Number.isSafeInteger(Number(n)) &&
    Number(n) <= 2147483647
    ? Number(n)
    : null;
};
export function yahooDateRange(from: string, to: string) {
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tokyo",
  });
  if (
    ![from, to].every(
      (s) =>
        /^\d{4}-\d{2}-\d{2}$/.test(s) &&
        new Date(s).toISOString().slice(0, 10) === s,
    ) ||
    from > to ||
    to > today ||
    Date.parse(to) - Date.parse(from) > 31 * 86400000
  )
    throw Error("取得期間は過去の日付で、31日以内を選んでください。");
}
export function yahooPurchaseQuery(from: string, to: string) {
  yahooDateRange(from, to);
  return `after:${Math.floor(Date.parse(from + "T00:00:00+09:00") / 1000) - 1} before:${Math.floor(Date.parse(to + "T00:00:00+09:00") / 1000) + 86400} from:auction-master@mail.yahoo.co.jp {subject:落札者 subject:終了 subject:ご購入の確認 subject:購入内容の変更} -in:trash -in:spam`;
}
function transactionDate(text: string, received: string) {
  const receivedDate = new Date(received);
  const year = Number(
    receivedDate
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })
      .slice(0, 4),
  );
  const end = field(text, "終了日時").match(/^(\d{1,2})月\s*(\d{1,2})日/);
  if (end) {
    let d = `${year}-${end[1].padStart(2, "0")}-${end[2].padStart(2, "0")}`;
    if (Date.parse(d) > Date.parse(received) + 86400000)
      d = `${year - 1}${d.slice(4)}`;
    return d;
  }
  const p = field(text, "購入日時").match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  return p
    ? `${p[1]}-${p[2].padStart(2, "0")}-${p[3].padStart(2, "0")}`
    : receivedDate.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
/** Strict buyer-only templates. Mail bodies, buyer contact and payment credentials are never retained. */
export function parseYahooPurchaseMail(
  mail: PurchaseMail,
): YahooPurchaseEvent | null {
  const sender = (mail.from.match(/<([^>]+)>/)?.[1] || mail.from)
    .trim()
    .toLowerCase();
  if (
    sender !== "auction-master@mail.yahoo.co.jp" ||
    !Number.isFinite(Date.parse(mail.receivedAt))
  )
    return null;
  const s = mail.subject.normalize("NFKC"),
    t = mailText(mail),
    at = mail.receivedAt,
    date = transactionDate(t, at),
    orderId = field(t, "注文ID");
  if (/^【Yahoo!オークション】購入内容の変更/.test(s)) {
    return {
      kind: "CHANGE",
      orderId,
      auctionIds: [
        ...t.matchAll(/^オークションID\s*:\s*([a-z]?\d{6,15})\s*$/gm),
      ]
        .map((m) => m[1])
        .filter(auctionIdValid),
      at,
      lots: [],
    };
  }
  if (/^【Yahoo!オークション】ご購入の確認/.test(s)) {
    const sections = [
      ...t.matchAll(
        /^オークションID\s*:\s*([a-z]?\d{6,15})\s*\n([\s\S]*?)(?=\nオークションID\s*:|\n商品の合計金額|(?![\s\S]))/gm,
      ),
    ];
    const lots: YahooPurchase[] = [];
    for (const m of sections) {
      const price = m[2].match(/(?:^|\n)\s*([\d,]+)円×(\d+)\s*=\s*([\d,]+)円/),
        name = field(m[2], "商品情報"),
        total = price ? amount(price[3]) : null,
        q = Number(price?.[2]);
      if (
        !auctionIdValid(m[1]) ||
        !name ||
        total === null ||
        !Number.isSafeInteger(q) ||
        q < 1 ||
        Number(price![1].replaceAll(",", "")) * q !== total
      )
        return null;
      lots.push({
        auctionId: m[1],
        name,
        date,
        quantity: q,
        itemTotal: total,
        shipping: null,
        orderTotal: amount(field(t, "合計金額")),
        orderId,
        store: true,
        receivedAt: at,
        mailId: mail.gmailId,
        changed: false,
        warnings: [],
      });
    }
    const total = amount(field(t, "商品の合計金額")),
      shipping = amount(field(t, "送料")),
      paid = amount(field(t, "合計金額"));
    if (
      !lots.length ||
      !orderId ||
      new Set(lots.map((l) => l.auctionId)).size !== lots.length ||
      total !== lots.reduce((n, l) => n + l.itemTotal, 0)
    )
      return null;
    if (shipping !== null && paid === total + shipping) {
      const allocation = allocateYen(
        shipping,
        lots.map((l) => l.itemTotal),
      );
      lots.forEach((l, i) => (l.shipping = allocation[i]));
    } else
      lots.forEach((l) =>
        l.warnings.push("注文の送料・手数料・割引を確認してください。"),
      );
    return {
      kind: "ORDER",
      orderId,
      auctionIds: lots.map((l) => l.auctionId),
      at,
      lots,
    };
  }
  if (
    !/^Yahoo!オークション\s*-\s*(?:落札者|終了)\s*:/.test(s) ||
    !/商品「[^\n]+」を落札しました。/.test(t)
  )
    return null;
  const id = field(t, "オークションID"),
    name = field(t, "商品"),
    q = Number(field(t, "落札数量")),
    total =
      amount(field(t, "落札合計\\(税込\\)")) ?? amount(field(t, "落札合計"));
  if (
    !auctionIdValid(id) ||
    !name ||
    !Number.isSafeInteger(q) ||
    q < 1 ||
    total === null
  )
    return null;
  const subjectId = s.match(/\(([a-z]?\d{6,15})\)/)?.[1];
  if (subjectId && id !== subjectId) return null;
  return {
    kind: "WON",
    orderId: "",
    auctionIds: [id],
    at,
    lots: [
      {
        auctionId: id,
        name,
        date,
        quantity: q,
        itemTotal: total,
        shipping: null,
        orderTotal: null,
        orderId: "",
        store: /https:\/\/buy\.auctions\.yahoo\.co\.jp\/order\//.test(t),
        receivedAt: at,
        mailId: mail.gmailId,
        changed: false,
        warnings: [],
      },
    ],
  };
}
/** Largest remainder allocation preserves the order's exact yen total. */
export function allocateYen(total: number, weights: number[]) {
  const sum = weights.reduce((n, v) => n + v, 0);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !sum ||
    weights.some((v) => !Number.isSafeInteger(v) || v < 0) ||
    !Number.isSafeInteger(total * sum)
  )
    throw Error("金額を確認してください。");
  const r = weights.map((v) => Math.floor((total * v) / sum));
  const left = total - r.reduce((n, v) => n + v, 0);
  const order = weights
    .map((v, i) => ({ i, r: (total * v) % sum }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let i = 0; i < left; i++) r[order[i].i]++;
  return r;
}
export function consolidateYahooPurchases(
  events: YahooPurchaseEvent[],
  from: string,
  to: string,
) {
  const rows = new Map<string, YahooPurchase>();
  for (const e of [...events]
    .filter((e) => e.kind !== "CHANGE")
    .sort(
      (a, b) =>
        a.at.localeCompare(b.at) ||
        Number(a.kind === "ORDER") - Number(b.kind === "ORDER"),
    )) {
    for (const lot of e.lots) {
      const old = rows.get(lot.auctionId);
      if (!old) rows.set(lot.auctionId, { ...lot });
      else if (e.kind === "ORDER")
        rows.set(lot.auctionId, {
          ...lot,
          date: old.date < lot.date ? old.date : lot.date,
        });
      else
        rows.set(lot.auctionId, {
          ...old,
          date: lot.date < old.date ? lot.date : old.date,
        });
    }
  }
  for (const row of rows.values())
    if (
      events.some(
        (e) =>
          e.kind === "CHANGE" &&
          e.at >= row.receivedAt &&
          (e.auctionIds.includes(row.auctionId) ||
            (!!row.orderId && e.orderId === row.orderId)),
      )
    ) {
      row.changed = true;
      row.shipping = null;
      row.warnings.push(
        "購入内容の変更通知があります。取引ナビで最新の商品合計と送料を確認してください。",
      );
    }
  return [...rows.values()]
    .filter((r) => r.date >= from && r.date <= to)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.auctionId.localeCompare(b.auctionId),
    );
}
export function normalizeProcurementTitle(s: string) {
  return s
    .normalize("NFKC")
    .replace(/【[^】]*】/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

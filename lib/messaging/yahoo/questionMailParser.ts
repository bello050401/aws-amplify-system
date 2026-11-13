import { htmlToText, type MercariMailInput } from "../mercari/notificationMailParser";
import { yahooSenderAuthenticated } from "@/lib/saleCandidates/mailAuthentication";

export const YAHOO_QUESTION_QUERY = 'from:auction-master@mail.yahoo.co.jp subject:質問 -in:spam -in:trash -in:sent -in:drafts';
const auctionIdPattern = /^[a-z][0-9]{6,15}$/i;

export function yahooAuctionIdFromUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!/^page\d*\.auctions\.yahoo\.co\.jp$/.test(u.hostname)
      && u.hostname !== "auctions.yahoo.co.jp") return null;
    const id = u.pathname.match(/^\/(?:jp\/)?auction\/([a-z][0-9]{6,15})\/?$/i)?.[1]
      ?? (u.pathname === "/jp/show/qanda" ? u.searchParams.get("aID") : null);
    return id && auctionIdPattern.test(id) ? id.toLowerCase() : null;
  } catch { return null; }
}

export function yahooQuestionUrl(id: string): string | null {
  return auctionIdPattern.test(id) ? "https://auctions.yahoo.co.jp/jp/show/qanda?aID=" + id.toLowerCase() : null;
}

export function trustedYahooQuestionNotification(input: {from: string; authenticationResults: string; labels?: string[]}): boolean {
  if (input.labels?.some(l => ["SENT", "DRAFT", "SPAM", "TRASH"].includes(l))) return false;
  const sender = (input.from.match(/<([^<>]+)>/)?.[1] ?? input.from).trim().toLowerCase();
  return sender === "auction-master@mail.yahoo.co.jp"
    && yahooSenderAuthenticated([{name: "Authentication-Results", value: input.authenticationResults.replace(/\r?\n[ \t]+/g, " ")}]);
}

export type YahooQuestion = {
  status: "PARSED" | "PARSE_FAILED";
  auctionId: string | null;
  productName: string | null;
  messageText: string | null;
  questioner: string | null;
  reason: string | null;
};

/** Parse seller question notifications only; the notification boilerplate is never customer speech. */
export function parseYahooQuestionMail(mail: MercariMailInput): YahooQuestion | null {
  const sender = (mail.from.match(/<([^<>]+)>/)?.[1] ?? mail.from).trim().toLowerCase();
  if (sender !== "auction-master@mail.yahoo.co.jp") return null;
  if (!/^Yahoo!オークション\s*-\s*質問\s*[:：]/.test(mail.subject.trim())) return null;
  const text = (mail.text.trim() || htmlToText(mail.html)).replace(/\r\n?/g, "\n");
  const sellerNotice = /出品中の商品について[\s\S]*?質問が届きました/.test(text);
  // IDs are taken only from the official header/answer URL, not URLs inside the question.
  const header = text.split(/質問の内容\s*[:：]/)[0];
  const footer = text.match(/この質問に回答するには[\s\S]*/)?.[0] ?? "";
  const ids = [
    ...Array.from(header.matchAll(/オークションID\s*[:：]\s*([a-z][0-9]{6,15})\b/gi), m => m[1].toLowerCase()),
    ...Array.from((header + "\n" + footer).matchAll(/https?:\/\/[^\s<>「」"]+/g), m => yahooAuctionIdFromUrl(m[0])),
  ].filter((id): id is string => Boolean(id));
  const unique = [...new Set(ids)];
  const raw = text.match(/質問の内容\s*[:：]\s*\n([\s\S]*?)\n\s*この質問に回答するには/);
  let messageText = raw?.[1].trim() ?? null;
  if (messageText?.startsWith("「") && messageText.endsWith("」")) messageText = messageText.slice(1, -1).trim() || null;
  const reason = !sellerNotice ? "質問通知の形式を確認できません。ヤフオクの質問画面で確認してください。" : unique.length !== 1 ? "オークションIDを一意に確認できません。" : !messageText ? "質問本文を抽出できません。ヤフオクの質問画面で確認してください。" : null;
  return {
    status: reason ? "PARSE_FAILED" : "PARSED",
    auctionId: unique.length === 1 ? unique[0] : null,
    productName: header.match(/(?:^|\n)[ \t]*商品\s*[:：][ \t]*([^\n]+)/)?.[1].trim() ?? null,
    messageText,
    questioner: header.match(/出品中の商品について、\s*([^\n]+?)さんから/)?.[1].trim() ?? null,
    reason,
  };
}

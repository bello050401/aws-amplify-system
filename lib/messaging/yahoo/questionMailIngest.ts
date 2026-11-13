import "server-only";
import type { FetchedMail } from "../email/gmailClient";
import { recordIncomingWebhookMessage } from "../webhookStore";
import { enqueueInquiry } from "@/lib/inquiry/runtime/store";
import { parseYahooQuestionMail, yahooQuestionUrl, type YahooQuestion } from "./questionMailParser";
import type { processInquiryAndNotify } from "@/lib/inquiry/autoReply";

type DraftParams = Parameters<typeof processInquiryAndNotify>[0];
export type YahooQuestionPorts = {
  record: typeof recordIncomingWebhookMessage;
  enqueue: typeof enqueueInquiry;
};

export function yahooQuestionDraftParams(parsed: YahooQuestion, conversationId: string, sourceMessageId: string, who: string | null): DraftParams {
  const id = parsed.auctionId;
  return {
    conversationId, sourceMessageId, who,
    yahooAuctionId: id,
    productLookupHint: id ? `https://auctions.yahoo.co.jp/jp/auction/${id}` : null,
    productTitle: parsed.productName,
    skipGeneration: parsed.status !== "PARSED",
    skipReason: parsed.reason,
    inquiryKind: "PRODUCT_INQUIRY",
    additionalContext: "Yahoo!オークションの購入前の商品質問です。返信は質問画面から行うと公開されます。メールへの返信は届きません。質問者の個人情報を返信案に含めないでください。",
    skipIfAlreadyNotified: true,
  };
}

export async function ingestYahooQuestionMail(
  mail: FetchedMail, options: {who: string | null; mailbox?: string},
  ports: YahooQuestionPorts = {record: recordIncomingWebhookMessage, enqueue: enqueueInquiry},
) {
  const parsed = parseYahooQuestionMail(mail);
  if (!parsed) return null;
  // Masked Yahoo IDs are NOT unique customer IDs. Each notification is a separate question,
  // never a shared conversation for all bidders on the same auction.
  const conversationKey = `yahoo-question:${mail.gmailId}`;
  const stored = await ports.record({
    channel: "YAHOO_AUCTION",
    externalAccountId: options.mailbox ?? "primary",
    externalConversationId: conversationKey, externalCustomerId: conversationKey,
    externalMessageId: "gmail:" + mail.gmailId,
    body: parsed.messageText ?? "（質問本文を抽出できませんでした。ヤフオクの質問画面で確認してください。）",
    externalSentAt: mail.receivedAt,
    customerDisplayName: parsed.questioner,
    customerNameSource: "YAHOO_QUESTION_MAIL_MASKED",
    customerNameFetchedAt: mail.receivedAt, contentKind: "TEXT",
  });
  if (!stored.conversationId || !stored.messageId) throw Error("YAHOO_QUESTION_RECORD_INCOMPLETE");
  // Always retry the durable enqueue after a prior partial failure; event ID dedupes it.
  await ports.enqueue("YAHOO_AUCTION", options.mailbox ?? "primary", conversationKey,
    "gmail:" + mail.gmailId,
    {channel: "YAHOO_AUCTION", params: yahooQuestionDraftParams(parsed, stored.conversationId, stored.messageId, options.who)},
    mail.receivedAt);
  return {duplicated: "deduped" in stored, parseFailed: parsed.status === "PARSE_FAILED", answerUrl: parsed.auctionId ? yahooQuestionUrl(parsed.auctionId) : null};
}

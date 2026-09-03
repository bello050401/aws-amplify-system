import "server-only";
import { fetchMercariNotificationMails, GmailError } from "@/lib/messaging/email/gmailClient";
import { recordIncomingWebhookMessage } from "@/lib/messaging/webhookStore";
import { processInquiryAndNotify } from "@/lib/inquiry/autoReply";
import {
  buildProductLookupText,
  parseMercariNotificationMail,
  type MercariMailParseResult,
} from "./notificationMailParser";

/**
 * 2026-09-03 指示書 §13/§14/§15/§10: メルカリShops問い合わせメールの取り込み。
 *
 *   Gmail → 解析 → 共通の問い合わせ形式(Conversation/Message)
 *        → 商品特定 → AI返信案 → 社内LINE通知
 *
 * ── 解析に失敗しても捨てない ────────────────────────────────────
 *
 * §14。本文を取り出せなくても、**メールが届いた事実は必ず残す**。
 * その場合は解析できた範囲だけを本文として保存し、通知には
 * 【要確認】が付く(生成が走らないため failureReason が入る)。
 * 「読めなかったので無視する」が一番まずい —— 顧客は返事を待っている。
 *
 * ── 冪等性 ──────────────────────────────────────────────────────
 *
 * §10。externalMessageId にメールの Message-ID を使う。既存の
 * recordIncomingWebhookMessage が externalMessageId のGSIで重複を検出
 * するので、同じメールを何度取り込んでも会話は増えない。
 * ポーリングは同じメールを何度も見るため、ここが効かないと毎回通知が飛ぶ。
 */

export interface MailIngestResult {
  /** Gmailから取得したメール数。 */
  fetched: number;
  /** 問い合わせとして取り込んだ数。 */
  ingested: number;
  /** 既に取り込み済みだった数。 */
  duplicated: number;
  /** 解析に失敗したが保存した数(§14)。 */
  parseFailed: number;
  /** 問い合わせ通知ではなかった数。 */
  skipped: number;
  /** 取り込みに失敗した数。 */
  failed: number;
  messages: string[];
}

/**
 * 顧客本文として保存する文字列。
 *
 * 解析できたときは**顧客が書いた本文だけ**。商品名やURLを混ぜない ——
 * 混ぜるとAIが「顧客が商品URLを送ってきた」と読み、返信文で
 * 「お送りいただいたURLの商品ですが」のような、事実でない前置きを書く。
 *
 * 解析に失敗したときだけ、手がかりを添えて保存する。担当者が画面で
 * 元メールの内容をある程度たどれるようにするため。
 */
function bodyForStorage(parsed: MercariMailParseResult, subject: string): string {
  if (parsed.messageText) return parsed.messageText;
  return [
    "（このメールから問い合わせ本文を自動抽出できませんでした。メルカリShopsの管理画面でご確認ください。）",
    `件名: ${subject}`,
    parsed.productName ? `商品名: ${parsed.productName}` : null,
    parsed.productUrl ? `商品URL: ${parsed.productUrl}` : null,
    parsed.adminUrl ? `管理画面: ${parsed.adminUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 1回分の取り込み。
 *
 * 例外を投げるのは Gmail へ到達できないときだけ(呼び出し側が原因を
 * 表示できるようにするため)。個々のメールの失敗は結果に数えて続ける ——
 * 1通の異常で残り全部を取りこぼさない。
 */
export async function ingestMercariNotificationMails(params: { maxResults?: number; who: string | null }): Promise<MailIngestResult> {
  const result: MailIngestResult = {
    fetched: 0,
    ingested: 0,
    duplicated: 0,
    parseFailed: 0,
    skipped: 0,
    failed: 0,
    messages: [],
  };

  const mails = await fetchMercariNotificationMails(params.maxResults ?? 20);
  result.fetched = mails.length;

  for (const mail of mails) {
    try {
      const parsed = parseMercariNotificationMail(mail);

      if (parsed.status === "NOT_INQUIRY") {
        result.skipped++;
        continue;
      }
      if (parsed.status === "PARSE_FAILED") result.parseFailed++;

      // ── 共通の問い合わせ形式へ(§9) ──────────────────────
      //
      // 顧客の識別子はメールからは取れない(メルカリは顧客のメール
      // アドレスを通知に含めない)。**ニックネームを識別子に使わない** ——
      // 同名の別人が同じ会話にまとまってしまう。商品ごとの問い合わせ
      // として分けるため、商品IDを識別子に使い、それも無ければ
      // メール単位で分ける。
      const externalCustomerId = parsed.externalProductId
        ? `mercari-product:${parsed.externalProductId}`
        : `mercari-mail:${mail.messageId}`;

      const stored = await recordIncomingWebhookMessage({
        channel: "MERCARI_SHOPS",
        externalCustomerId,
        externalMessageId: mail.messageId,
        body: bodyForStorage(parsed, mail.subject),
        externalSentAt: mail.receivedAt,
        customerDisplayName: parsed.customerName,
        customerNameSource: parsed.customerName ? "MERCARI_MAIL" : "MERCARI_MAIL_NOT_FOUND",
        customerNameFetchedAt: new Date().toISOString(),
        contentKind: "TEXT",
      });

      if ("deduped" in stored) {
        result.duplicated++;
        continue;
      }
      result.ingested++;

      // ── 商品特定 → 返信案 → 通知 ────────────────────────
      //
      // 商品特定は既存の productResolver に任せる(§15 の優先順位も
      // そちらが実装済み)。メールから取れた商品URL・商品名は
      // productLookupHint として渡し、**本文とは別扱い**にする。
      await processInquiryAndNotify({
        conversationId: stored.conversationId,
        sourceMessageId: stored.messageId,
        who: params.who,
        productLookupHint: buildProductLookupText(parsed),
      });
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      result.messages.push(`1件の取り込みに失敗しました: ${message}`);
      console.error("[mercariMailIngest] 取り込みに失敗", { messageId: mail.messageId, message });
    }
  }

  if (result.parseFailed > 0) {
    result.messages.push(
      `${result.parseFailed}件は本文を自動抽出できませんでした。受信自体は保存済みで、通知には【要確認】が付いています。`,
    );
  }
  return result;
}

export { GmailError };

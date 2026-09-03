import "server-only";
import {
  fetchMercariNotificationMailsByIds,
  listMercariNotificationMailIds,
  GmailError,
} from "@/lib/messaging/email/gmailClient";
import { findMessageByExternalId, recordIncomingWebhookMessage } from "@/lib/messaging/webhookStore";
import { processInquiryAndNotifyUnauthenticated } from "@/lib/inquiry/autoReply";
import {
  buildProductLookupText,
  canonicalOrderId,
  conversationKeyFor,
  parseMercariNotificationMail,
  type MercariMailParseResult,
} from "./notificationMailParser";
import { listAllMercariOrderContexts } from "./orderContextStore";
import { recordOrderContextFromMail, restoreOrderProduct } from "./orderProductContext";

/**
 * 2026-09-03 追加指示 §1-§6: メルカリShops問い合わせメールの取り込み。
 *
 *   Gmail → 解析 → Conversation/Message → 商品特定 → AI返信案 → 社内LINE通知
 *
 * ── 解析に失敗しても捨てない。ただし推測もしない ────────────────
 *
 * §3。本文を取り出せなくても、**メールが届いた事実は必ず残す**。
 * ただし取れなかった本文を件名や商品名で代用しない —— 以前それをやって、
 * AIが件名だけを材料に「素材」と誤分類していた。本文が無いときは
 * 分類も返信案生成も走らせず、社内へ【要確認】として出す。
 *
 * ── 冪等性 ──────────────────────────────────────────────────────
 *
 * §5/§6。**Gmail の message ID**をメール単位の鍵にする。「今すぐ取り込む」を
 * 何度押しても、同じメールから2件目のMessageは作られない。
 * 会話は問い合わせページID(`/inquiries/<ID>`)でまとめるので、同じ問い合わせへの
 * 追加メールは既存の会話へ足される。
 */

export interface MailIngestResult {
  fetched: number;
  /** 問い合わせとして取り込んだ数。 */
  ingested: number;
  /** 既に取り込み済みだった数(高速SKIP)。 */
  duplicated: number;
  /** 取り込み済みだが、修正後の処理でやり直した数(§10)。 */
  reprocessed: number;
  /** 本文を抽出できなかったが保存した数(§3)。 */
  parseFailed: number;
  /**
   * 購入通知として取り込み、注文→商品の対応だけを登録した数
   * (2026-09-04 追加指示 §62/§63)。会話もAI返信も社内通知も作っていない。
   */
  purchaseNotifications: number;
  /** 問い合わせ通知ではなかった数。 */
  skipped: number;
  failed: number;
  /** まだ処理していないメールが残っているか(1回の上限で打ち切った場合)。 */
  remaining: number;
  /** 実際にGmailへ渡した検索条件。画面表示と突き合わせられるようにする。 */
  query: string;
  messages: string[];
}

/**
 * 1回の実行で本文まで取りに行く上限。
 *
 * Server Action はホスティング側の実行時間上限の中で必ず返さなければ
 * ならない。**返せないと、画面には結果が届かず「押しても何も起きない」
 * ように見える**(実際にそれが起きた)。1通あたりGmail APIの往復とAI生成が
 * 入るので、確実に返せる件数で区切り、残りは次回に回す。
 */
const MAX_PER_RUN = 8;

/**
 * 保存する本文。
 *
 * 解析できたときは**顧客が書いた本文だけ**。商品名やURLを混ぜない ——
 * 混ぜるとAIが「顧客が商品情報を送ってきた」と読み、事実でない前置きを書く。
 *
 * 解析に失敗したときは、**本文の代わりになるものを置かない**。
 * 「抽出できなかった」という事実だけを書く。ここに件名や商品名を入れると、
 * 後段がそれを顧客の発言として扱ってしまう(実際にそれで誤分類が出た)。
 */
function bodyForStorage(parsed: MercariMailParseResult): string {
  if (parsed.messageText) return parsed.messageText;
  return "（このメールから問い合わせ本文を抽出できませんでした。メルカリShopsの管理画面でご確認ください。）";
}

/**
 * 商品特定と返信生成のためにAIへ渡す前提。
 *
 * §2。取引メッセージは**購入済み**の注文に対するやり取りなので、
 * 「購入をご検討ください」のような返信は的外れになる。購入済みであることと
 * 注文情報を、顧客本文とは別の事実として渡す。
 */
function contextFor(parsed: MercariMailParseResult): string | null {
  if (parsed.kind !== "ORDER_MESSAGE") return null;
  const lines = ["このお問い合わせは、**購入済みの注文**に対する取引メッセージです。購入前の商品問い合わせとして扱わないでください。"];
  if (parsed.order.orderNumber) lines.push(`注文番号: ${parsed.order.orderNumber}`);
  if (parsed.productName) lines.push(`商品名: ${parsed.productName}`);
  if (parsed.quantity != null) lines.push(`数量: ${parsed.quantity}`);
  if (parsed.order.totalAmountYen != null) lines.push(`合計金額: ${parsed.order.totalAmountYen.toLocaleString("ja-JP")}円`);
  if (parsed.order.shippingFeeYen != null) lines.push(`送料: ${parsed.order.shippingFeeYen.toLocaleString("ja-JP")}円`);
  return lines.join("\n");
}

/**
 * 1回分の取り込み。
 *
 * 例外を投げるのは Gmail へ到達できないときだけ。個々のメールの失敗は
 * 結果に数えて続ける —— 1通の異常で残り全部を取りこぼさない。
 */
export async function ingestMercariNotificationMails(params: {
  maxResults?: number;
  who: string | null;
  /**
   * 取り込み済みのメールも解析・通知をやり直す(§10)。
   *
   * パーサや商品照合を直した後に、既存のログを正しい内容へ更新するために使う。
   * **会話もメッセージも新しく作らない** —— 既存の行をそのまま使い、
   * 返信案と通知の内容だけが最新の処理結果で置き換わる
   * (通知は dedupeKey が同じなので更新され、重複しない)。
   */
  reprocess?: boolean;
}): Promise<MailIngestResult> {
  const result: MailIngestResult = {
    fetched: 0,
    ingested: 0,
    duplicated: 0,
    reprocessed: 0,
    parseFailed: 0,
    purchaseNotifications: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    query: "",
    messages: [],
  };

  // ── まずIDだけ取る ────────────────────────────────────────
  //
  // 本文まで取ると1通ごとにAPIを1往復するため、30通で十数秒かかる。
  // 取り込み済みかはIDだけで判定できるので、**新しいものだけ本文を取りに行く**。
  // これで2回目以降の実行が数秒で終わる。
  const { ids, query } = await listMercariNotificationMailIds(params.maxResults ?? 30);
  result.query = query;
  result.fetched = ids.length;

  // 購入通知は Message を作らない(§63)ので、メッセージ側の重複判定に
  // 載らない。取り込んだGmail message IDを注文の対応表に残してあるので、
  // それを使って**同じ購入通知を毎回取りに行かない**ようにする。
  // ここを省くと、上限(MAX_PER_RUN)を購入通知が毎回食い潰し、本物の
  // 問い合わせが後回しになる。
  const orderContexts = await listAllMercariOrderContexts();
  const seenPurchaseMailIds = new Set(orderContexts.flatMap((c) => c.sourceGmailIds));

  const unseen: string[] = [];
  for (const id of ids) {
    const existing = await findMessageByExternalId(`gmail:${id}`);
    if ((existing || seenPurchaseMailIds.has(id)) && !params.reprocess) result.duplicated++;
    else unseen.push(id);
  }

  // 1回で処理する分だけ本文を取る。残りは次回。
  const batch = unseen.slice(0, MAX_PER_RUN);
  result.remaining = unseen.length - batch.length;
  const mails = await fetchMercariNotificationMailsByIds(batch);

  for (const mail of mails) {
    try {
      const parsed = parseMercariNotificationMail(mail);

      // 問い合わせ通知でないメール(キャンペーン・売上速報・サポート返信)は
      // 取り込まない。**ここが緩いと会話が大量に増える** —— 実際に
      // ニュースレターまで会話として取り込んでいた。
      if (parsed.status === "NOT_INQUIRY") {
        result.skipped++;
        continue;
      }

      // ── §62/§63 購入通知 ──────────────────────────────────
      //
      // 問い合わせではない。**会話もAI返信も社内通知も作らない。**
      // やることは「注文番号 → 商品」の登録だけ。ここで作った対応が、
      // 後続の取引メッセージにおける商品復元の主経路になる(§65)。
      if (parsed.status === "PURCHASE_NOTIFICATION") {
        const saved = await recordOrderContextFromMail({
          parsed,
          gmailId: mail.gmailId,
          receivedAt: mail.receivedAt,
          who: params.who,
        });
        result.purchaseNotifications++;
        if (!saved) {
          result.messages.push(
            `購入通知を解析しましたが、注文番号を取り出せなかったため対応表へ登録できませんでした(Gmail ID: ${mail.gmailId})。`,
          );
        }
        continue;
      }

      if (parsed.status === "PARSE_FAILED") result.parseFailed++;

      // ── §50/§65 注文番号から商品Contextを復元する ──────────
      //
      // 取引メッセージは購入後のやり取りで、商品名が落ちることがある。
      // **即座に「特定できませんでした」にしない。** 保存済みの対応表
      // (購入通知由来が主経路)を引き、無ければGmailを注文番号で検索する。
      const orderId = canonicalOrderId(parsed.order.orderNumber);
      const restored = orderId
        ? await restoreOrderProduct({
            orderId,
            inquiryId: parsed.inquiryId,
            mailProductName: parsed.productName,
          })
        : null;
      const productName = restored?.productName ?? parsed.productName;

      // 今回のメールから分かる注文情報を対応表へ足す(§51/§59)。
      // 商品名が今回のメールにあるなら、在庫までここで解決して保存する
      // —— 次の取引メッセージが再解析しなくて済む。
      if (orderId) {
        await recordOrderContextFromMail({
          parsed: productName === parsed.productName ? parsed : { ...parsed, productName },
          gmailId: mail.gmailId,
          receivedAt: mail.receivedAt,
          who: params.who,
        });
      }

      // ── 会話の鍵(§5) ────────────────────────────────────
      // 同じ問い合わせページ → 同じConversation。
      const externalCustomerId = conversationKeyFor(parsed, mail.messageId);

      // ── メールの鍵(§6) ────────────────────────────────────
      // **Gmail の message ID** を使う。Message-IDヘッダは転送や
      // エイリアスで落ちることがあり、落ちると同じメールが二重に入る。
      const stored = await recordIncomingWebhookMessage({
        channel: "MERCARI_SHOPS",
        externalCustomerId,
        externalMessageId: `gmail:${mail.gmailId}`,
        body: bodyForStorage(parsed),
        externalSentAt: mail.receivedAt,
        // 顧客名はメールに含まれない。**作らない。**
        customerDisplayName: null,
        customerNameSource: "MERCARI_MAIL_NO_NAME",
        customerNameFetchedAt: new Date().toISOString(),
        contentKind: "TEXT",
      });

      let conversationId: string;
      let messageId: string;
      if ("deduped" in stored) {
        // §6 2回目以降は高速SKIP。AIも呼ばない。
        if (!params.reprocess || !stored.conversationId || !stored.messageId) {
          result.duplicated++;
          continue;
        }
        // §10 やり直しモード。既存の行をそのまま使う(新規に作らない)。
        conversationId = stored.conversationId;
        messageId = stored.messageId;
        result.reprocessed++;
      } else {
        conversationId = stored.conversationId;
        messageId = stored.messageId;
        result.ingested++;
      }

      await processInquiryAndNotifyUnauthenticated({
        conversationId,
        sourceMessageId: messageId,
        who: params.who,
        // §4 メールに商品URLは無い。出品タイトルをそのまま高信頼の照合へ渡す。
        // §50 今回のメールに商品名が無ければ、注文番号から復元したものを使う。
        productLookupHint: buildProductLookupText({ ...parsed, productName }),
        productTitle: productName,
        // §3 本文が取れていないなら、分類も返信案生成もしない。
        skipGeneration: parsed.status === "PARSE_FAILED",
        skipReason:
          parsed.status === "PARSE_FAILED"
            ? "メルカリShopsメール本文の抽出に失敗しました。件名や商品名から内容を推測せず、管理画面で原文をご確認ください。"
            : null,
        // §2 購入済みの文脈をAIへ渡す。
        additionalContext: contextFor({ ...parsed, productName }),
        // §9 通知の見出しと注文番号に使う。
        inquiryKind: parsed.kind === "PURCHASE_NOTIFICATION" ? null : parsed.kind,
        orderNumber: orderId,
        // §54/§55 注文情報は強い証拠として扱う。会話Contextへ保持し、
        // 後続の短いメッセージでも注文・商品・配送の文脈を失わない。
        order: orderId
          ? {
              orderId,
              productName,
              itemAmountYen: parsed.order.itemAmountYen,
              shippingFeeYen: parsed.order.shippingFeeYen,
              couponDiscountYen: parsed.order.couponDiscountYen,
              totalAmountYen: parsed.order.totalAmountYen,
              inventoryId: restored?.record?.inventoryId ?? null,
              baseItemId: restored?.record?.baseItemId ?? null,
              baseUrl: restored?.record?.baseUrl ?? null,
            }
          : null,
        // §50 どうやって商品名へ辿り着いたか。社内通知の「商品情報の補完」に出す。
        productContextNotes: restored?.notes ?? [],
      });
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      result.messages.push(`1件の取り込みに失敗しました: ${message}`);
      console.error("[mercariMailIngest] 取り込みに失敗", { gmailId: mail.gmailId, message });
    }
  }

  if (result.remaining > 0) {
    result.messages.push(
      `未処理のメールが${result.remaining}件残っています。1回あたり${MAX_PER_RUN}件までに区切っているので、もう一度実行してください。`,
    );
  }
  if (result.parseFailed > 0) {
    result.messages.push(
      `${result.parseFailed}件は本文を抽出できませんでした。受信は保存済みで、社内通知は【要確認】になっています(分類・返信案は生成していません)。`,
    );
  }
  if (result.purchaseNotifications > 0) {
    result.messages.push(
      `${result.purchaseNotifications}件は購入通知でした。注文番号と商品の対応だけを登録しています(会話・返信案・社内通知は作成していません)。`,
    );
  }
  return result;
}

export { GmailError };

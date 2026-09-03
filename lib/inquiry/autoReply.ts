import "server-only";
import { runWithDirectData } from "@/lib/amplify/dataClient";
import { getConversation, listMessages } from "@/lib/messaging/service";
import { notifyInquiry, type NotifyResult } from "@/lib/messaging/lineNotify/service";
import { buildDedupeKey } from "@/lib/messaging/lineNotify/deliveryPolicy";
import { findDeliveryByDedupeKey } from "@/lib/messaging/lineNotify/deliveryStore";
import { generateInquiryReplyDraft } from "./pipeline";
import { loadConversationContext, saveConversationContext } from "./contextStore";
import { mergeConversationContext } from "./conversationContext";
import { saveReplyDraft } from "./draftStore";
import { getAIReplySettings } from "./settings";
import { detectDeliveryDateIntent, evaluateDeliveryWindow, extractRequestedDeliveryDate } from "./deliveryWindow";
import type { DeliveryWindowState } from "./deliveryWindow";
import type { ReplyDraftRecord } from "./types";

/**
 * 2026-09-03 指示書 §1/§7/§34: 受信 → 解析 → 返信案 → 社内LINE通知。
 *
 * ── なぜ同期処理なのか(正直に) ──────────────────────────────────
 *
 * 本来はキュー + ワーカーへ逃がすのが筋。ただし現状の Next.js は 14.2 で
 * `after()` が無く、レスポンスを返した後に処理を続ける安全な口が無い。
 * 「awaitせずに投げっぱなし」にすると、Amplify Hosting(Lambda)が
 * レスポンス後にコンテナを凍結した時点で処理が消える —— **通知したつもり
 * で誰にも届いていない**という、一番たちの悪い壊れ方になる。
 *
 * そこで今は Webhook の中で最後まで走らせる。遅くはなるが、
 *
 *   - メッセージの保存は**この関数より前に**完了している(失われない)
 *   - LINEがタイムアウトして再送しても、メッセージ側は externalMessageId、
 *     通知側は dedupeKey で重複しない(§10)
 *
 * ので、遅延の代償は「無駄な再送が起きうる」だけで、データは壊れない。
 * 将来ワーカーへ移すときは、この関数をそのまま呼べばよい形にしてある。
 *
 * ── 例外を投げない ──────────────────────────────────────────────
 *
 * §8。ここで throw すると Webhook が 500 を返し、LINEが再送を繰り返す。
 * 失敗は結果として返し、呼び出し側が 200 を返せるようにする。
 */

export interface AutoReplyResult {
  /** 返信案を生成できたか。 */
  drafted: boolean;
  draft: ReplyDraftRecord | null;
  /** 通知の結果。通知まで到達しなかった場合は null。 */
  notify: NotifyResult | null;
  /** 何が起きたか(ログと画面用)。 */
  reason: string;
}

/**
 * 配送希望日の判定。**§17 の2週間ルールに乗せるためだけ**に使う。
 *
 * 購入日が分からない場合は「今日購入した」と仮定しない —— 仮定すると
 * 2週間の起点がずれ、本来【要確認】にすべきものが素通りする。
 * 判定できないときは null を返し、要確認判定へ影響させない。
 */
function evaluateDeliveryState(messageText: string): DeliveryWindowState | null {
  if (!detectDeliveryDateIntent(messageText)) return null;
  const requested = extractRequestedDeliveryDate(messageText);
  if (!requested) return "DATE_INFO_REQUIRED";
  // 問い合わせ時点をこれから購入する日として扱う。実際の購入日が
  // 分かる経路(注文連携)ができたら、そちらを渡すよう差し替える。
  return evaluateDeliveryWindow({ purchaseDate: new Date(), requestedDeliveryDate: requested }).state;
}

/**
 * 会話の最新の受信メッセージについて、返信案を作って社内LINEへ通知する。
 *
 * @param sourceMessageId 対象の受信メッセージ。省略時は最新のINBOUND。
 */
/**
 * 未認証の経路(LINE Webhook / メール取込 / 定期実行)向けの入口。
 *
 * runWithDirectData の中で実行することで、この呼び出しの下にある
 * serverDataClient の読み書きがすべてDynamoDB直結になる
 * (lib/amplify/dataClient.ts の Proxy)。呼び出し側も下位モジュールも
 * コードは1行も変えていない。
 *
 * 認証済みの経路(Server Action)からは**こちらを使わない** ——
 * AppSyncの認可チェックを回さずに読み書きすることになる。
 */
export function processInquiryAndNotifyUnauthenticated(
  params: Parameters<typeof processInquiryAndNotify>[0],
): Promise<AutoReplyResult> {
  return runWithDirectData(() => processInquiryAndNotify(params));
}

export async function processInquiryAndNotify(params: {
  conversationId: string;
  sourceMessageId?: string | null;
  who: string | null;
  /**
   * 商品特定にだけ使う追加テキスト(メール経由の商品名・商品URL)。
   * 顧客本文には混ぜない —— lib/inquiry/types.ts の productLookupText 参照。
   */
  productLookupHint?: string | null;
  /**
   * 既に通知済みなら、AIを呼ばずに終える。
   *
   * LINEの再送経路から呼ぶときに使う。再送は「一度目の処理が最後まで
   * 進まなかったかもしれない」という機会である一方、**実際には通知まで
   * 完了していることのほうが多い**。通知側の dedupeKey は二重送信を止めて
   * くれるが、そこへ辿り着くまでにAIを1回呼んでしまう。課金と時間の無駄
   * なので、先に通知の有無を見る。
   */
  skipIfAlreadyNotified?: boolean;
  /**
   * 分類・返信案の生成を行わない(2026-09-03 追加指示§3)。
   *
   * メール本文の抽出に失敗したときに使う。**件名や商品名だけから
   * 問い合わせ意図を推測させない** —— 実際にそれで「素材」という
   * 誤分類と、的外れな返信案が生成された。
   */
  skipGeneration?: boolean;
  /** skipGeneration の理由。社内通知へそのまま出す。 */
  skipReason?: string | null;
  /**
   * 顧客本文とは別に、事実としてAIへ渡す前提(§2)。
   * 取引メッセージの「購入済み」と注文情報がこれにあたる。
   */
  additionalContext?: string | null;
  /** メール由来の問い合わせ種別。通知の見出しに使う(§9)。 */
  inquiryKind?: "PRODUCT_INQUIRY" | "ORDER_MESSAGE" | null;
  /** 取引メッセージの注文番号。通知の1通目に出す(§9)。 */
  orderNumber?: string | null;
  /** 販売チャネル側の正式な商品名(§4)。高信頼の照合へ渡す。 */
  productTitle?: string | null;
}): Promise<AutoReplyResult> {
  try {
    const settings = await getAIReplySettings();

    const [conversation, messages] = await Promise.all([
      getConversation(params.conversationId),
      listMessages(params.conversationId),
    ]);
    if (!conversation) {
      // 静かに終わらせない。原因が分かる形でログへ残す。
      //
      // 未認証の経路から processInquiryAndNotifyUnauthenticated を経由せずに
      // 直接呼ぶと、AppSyncの認可で弾かれて必ずここへ来る(data が null で返る)。
      // 呼び出し経路の取り違えを疑えるよう、その可能性を文面へ残す。
      const message =
        "会話を読み込めませんでした。未認証の経路から呼ぶ場合は " +
        "processInquiryAndNotifyUnauthenticated を使ってください(AppSyncの認可で弾かれます)。";
      console.error("[autoReply] " + message, { conversationId: params.conversationId });
      return { drafted: false, draft: null, notify: null, reason: message };
    }

    const target = params.sourceMessageId
      ? messages.find((m) => m.id === params.sourceMessageId && m.direction === "INBOUND")
      : [...messages].reverse().find((m) => m.direction === "INBOUND");
    if (!target) {
      return { drafted: false, draft: null, notify: null, reason: "対象の受信メッセージが見つかりませんでした。" };
    }

    // 既に通知が済んでいるなら、ここで終える。AIを呼ぶ前に見る。
    if (params.skipIfAlreadyNotified) {
      const dedupeKey = buildDedupeKey({
        channel: conversation.channel,
        conversationId: conversation.id,
        sourceMessageId: target.id,
      });
      const existing = await findDeliveryByDedupeKey(dedupeKey);
      if (existing && (existing.status === "SENT" || existing.status === "PROCESSING")) {
        return { drafted: false, draft: null, notify: null, reason: "この問い合わせは既に通知済みです。" };
      }
    }

    const history = messages
      .filter((m) => m.id !== target.id)
      .slice(-10)
      .map((m) => ({ direction: m.direction, body: m.body }));

    // ── 会話文脈(2026-09-03 追加指示 §17/§25) ────────────────
    //
    // **新着メッセージだけを見て処理しない。** 処理の順序は
    //   会話を取得 → 過去メッセージと文脈を取得 → 今回の分を足す →
    //   商品特定・分類・生成 → 文脈を保存 → 通知
    // で、この関数がその順序そのものになっている。
    //
    // 読めなかったことは黙って握りつぶさず、社内確認の理由として残す。
    const loadedContext = await loadConversationContext(conversation.id);
    const contextIssues: string[] = [];
    if (!loadedContext.loaded && loadedContext.reason) contextIssues.push(loadedContext.reason);

    // ── 返信案 ────────────────────────────────────────────────
    //
    // 生成が無効化されていても**通知はする**(§34の精神)。返信案が無い
    // ことと、問い合わせが来たことを知らせないことは全く違う。
    let generated: Awaited<ReturnType<typeof generateInquiryReplyDraft>> | null = null;
    let failureReason: string | null = null;

    if (params.skipGeneration) {
      // §3 本文が無い状態で分類・生成へ進めない。**推測させない。**
      failureReason = params.skipReason ?? "問い合わせ本文を取得できなかったため、分類と返信案の生成を行いませんでした。";
    } else if (!settings.autoDraftEnabled) {
      failureReason = "AI返信案の生成が設定で無効になっています。";
    } else {
      try {
        generated = await generateInquiryReplyDraft({
          channel: conversation.channel,
          conversationId: conversation.id,
          messageId: target.id,
          messageText: target.body,
          history,
          context: loadedContext.context,
          conversationInventoryId: conversation.relatedInventoryId,
          productLookupText: params.productLookupHint ?? null,
          productTitle: params.productTitle ?? null,
          additionalContext: params.additionalContext ?? null,
        });
      } catch (err) {
        // 生成の失敗で通知まで止めない(§34)。
        failureReason = err instanceof Error ? err.message : String(err);
      }
    }

    let draft: ReplyDraftRecord | null = null;
    if (generated) {
      try {
        draft = await saveReplyDraft(
          {
            conversationId: conversation.id,
            sourceMessageId: target.id,
            resolvedInventoryId: generated.evidence.product?.inventoryId ?? null,
            productMatchConfidence: generated.evidence.product?.confidence ?? null,
            intents: generated.intents,
            draftText: generated.draftText,
            unresolvedFacts: generated.unresolvedFacts,
            evidence: generated.evidence,
            modelProvider: generated.modelProvider,
            modelName: generated.modelName,
            status: generated.status,
            failureReason: generated.failureReason,
          },
          params.who,
        );
      } catch (err) {
        // 保存に失敗しても通知はする。生成結果はメモリ上にあるので、
        // 内容そのものは届けられる。
        console.error("[autoReply] 返信案の保存に失敗しました", err instanceof Error ? err.message : String(err));
      }
      if (generated.failureReason) failureReason = generated.failureReason;
    }

    // ── 会話文脈を保存する ────────────────────────────────────
    //
    // 通知より**前**に保存する。通知は失敗しうる(LINE APIの障害、
    // 通知先未登録)が、そのときに文脈まで失うと次のメッセージで
    // また商品特定からやり直しになる。
    //
    // 保存は「読んだ版と一致するときだけ」書く。同じ会話へ短時間に
    // 2通届いたとき、片方の更新が消えるのを防ぐ(§25)。競合したら
    // 読み直して同じマージをやり直すので、両方の更新が残る。
    if (generated) {
      const result = generated;
      const saved = await saveConversationContext(conversation.id, (current) =>
        // current は競合時に読み直された最新値。そこへ**今回分かったことを
        // 足す**形で書く(上書きしない)。
        mergeConversationContext(current, {
          channel: result.context.channel,
          identifiedProduct: result.context.identifiedProduct,
          negotiation: result.context.negotiation,
          shipping: result.context.shipping,
          order: result.context.order,
          intents: result.context.intents,
          knowledgeDocumentIds: result.context.knowledgeDocumentIds,
          reviewReasons: result.context.reviewReasons,
        }),
      );
      if (!saved.saved && saved.reason) contextIssues.push(saved.reason);
      // 確認待ちの項目は「足す」ではなく「今回の結果で置き換える」。
      // 解消した項目が残り続けると、次の関係ないメッセージを回答として
      // 読んでしまう。競合時の再実行でも同じ結果になるので、マージの外で行う。
      if (saved.saved) {
        await saveConversationContext(conversation.id, (current) => ({
          ...current,
          pendingQuestions: result.context.pendingQuestions,
        }));
      }
    }

    // ── 通知 ──────────────────────────────────────────────────
    const notify = await notifyInquiry({
      conversationId: conversation.id,
      sourceMessageId: target.id,
      channel: conversation.channel,
      customerName: conversation.customerDisplayName,
      messageText: target.body,
      intents: generated?.intents ?? [],
      evidence: generated?.evidence ?? null,
      draftText: generated?.draftText ?? null,
      replyDraftId: draft?.id ?? null,
      draftStatus: generated?.status ?? null,
      deliveryWindowState: evaluateDeliveryState(target.body),
      // §27 引き継いだ情報を1通目に出す。「埼玉です」だけを見せられても
      // 担当者は判断できない。
      carriedFacts: generated?.carriedFacts ?? [],
      answeredQuestions: generated?.answeredQuestions ?? [],
      productContextNotes: generated?.productContextNotes ?? [],
      contextIssues,
      failureReason,
      createdBy: params.who,
      inquiryKind: params.inquiryKind ?? null,
      orderNumber: params.orderNumber ?? null,
      // §3 本文が取れていない場合は、通知側でもそれと分かるようにする。
      parseFailed: Boolean(params.skipGeneration),
    });

    return {
      drafted: Boolean(generated?.draftText),
      draft,
      notify,
      reason: notify.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[autoReply] 処理に失敗しました", { conversationId: params.conversationId, message });
    return { drafted: false, draft: null, notify: null, reason: `処理に失敗しました: ${message}` };
  }
}

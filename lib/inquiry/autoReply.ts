import "server-only";
import { getConversation, listMessages } from "@/lib/messaging/service";
import { notifyInquiry, type NotifyResult } from "@/lib/messaging/lineNotify/service";
import { generateInquiryReplyDraft } from "./pipeline";
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
export async function processInquiryAndNotify(params: {
  conversationId: string;
  sourceMessageId?: string | null;
  who: string | null;
}): Promise<AutoReplyResult> {
  try {
    const settings = await getAIReplySettings();

    const [conversation, messages] = await Promise.all([
      getConversation(params.conversationId),
      listMessages(params.conversationId),
    ]);
    if (!conversation) {
      return { drafted: false, draft: null, notify: null, reason: "会話が見つかりませんでした。" };
    }

    const target = params.sourceMessageId
      ? messages.find((m) => m.id === params.sourceMessageId && m.direction === "INBOUND")
      : [...messages].reverse().find((m) => m.direction === "INBOUND");
    if (!target) {
      return { drafted: false, draft: null, notify: null, reason: "対象の受信メッセージが見つかりませんでした。" };
    }

    const history = messages
      .filter((m) => m.id !== target.id)
      .slice(-10)
      .map((m) => ({ direction: m.direction, body: m.body }));

    // ── 返信案 ────────────────────────────────────────────────
    //
    // 生成が無効化されていても**通知はする**(§34の精神)。返信案が無い
    // ことと、問い合わせが来たことを知らせないことは全く違う。
    let generated: Awaited<ReturnType<typeof generateInquiryReplyDraft>> | null = null;
    let failureReason: string | null = null;

    if (!settings.autoDraftEnabled) {
      failureReason = "AI返信案の生成が設定で無効になっています。";
    } else {
      try {
        generated = await generateInquiryReplyDraft({
          channel: conversation.channel,
          conversationId: conversation.id,
          messageId: target.id,
          messageText: target.body,
          history,
          conversationInventoryId: conversation.relatedInventoryId,
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
      failureReason,
      createdBy: params.who,
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

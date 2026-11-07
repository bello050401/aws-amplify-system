import "server-only";
import {
  claimInquiry,
  eventsFor,
  finishInquiry,
  releaseInquiry,
  stillCurrent,
  inquirySettings,
  stateFor,
} from "./store";
import { receiveLine } from "./lineReceive";
import { processInquiryAndNotifyUnauthenticated } from "@/lib/inquiry/autoReply";
import { listMessages } from "@/lib/messaging/service";
import { runWithDirectData } from "@/lib/amplify/dataClient";

export async function runInquiry(
  pk: string,
): Promise<{ retrySeconds?: number; state: string }> {
  const settings = await inquirySettings();
  if (!settings.enabled) return { retrySeconds: 60, state: "PAUSED" };
  const claim = await claimInquiry(pk);
  if (!claim) return { state: "IDLE" };
  if ("retrySeconds" in claim)
    return { retrySeconds: claim.retrySeconds, state: "WAITING" };
  const { state, owner } = claim;
  try {
    const events = await eventsFor(state);
    // A withdrawal is applied before any message in the same delivery batch.
    events.sort(
      (a, b) =>
        Number(
          b.payload.channel === "LINE" && b.payload.event.type === "unsend",
        ) -
          Number(
            a.payload.channel === "LINE" && a.payload.event.type === "unsend",
          ) || a.version - b.version,
    );
    let params:
      Parameters<typeof processInquiryAndNotifyUnauthenticated>[0] | null =
      null;
    const byMessage = new Map<
      string,
      Parameters<typeof processInquiryAndNotifyUnauthenticated>[0]
    >();
    for (const item of events) {
      if (item.payload.channel === "LINE") {
        const stored = await receiveLine(
          item.payload.account,
          item.payload.event,
        );
        if (stored?.conversationId && stored.messageId)
          params = {
            conversationId: stored.conversationId,
            sourceMessageId: stored.messageId,
            who: null,
            skipIfAlreadyNotified: true,
          };
      } else params = item.payload.params;
      if (params?.sourceMessageId)
        byMessage.set(params.sourceMessageId, params);
    }
    if ((await stateFor(pk))?.mode === "STAFF") {
      await finishInquiry(
        state,
        owner,
        "STAFF_CONFIRMATION",
        "社員が対応中です。返信案の自動作成を停止しています。",
        params?.conversationId,
      );
      return { state: "STAFF_CONFIRMATION" };
    }
    if (!(await stillCurrent(state, owner))) {
      await releaseInquiry(state, owner);
      return { retrySeconds: 1, state: "STALE" };
    }
    if (!params) {
      await finishInquiry(
        state,
        owner,
        "STAFF_CONFIRMATION",
        "送信取消など、返信案を作らない通知を記録しました。",
      );
      return { state: "RECORDED" };
    }
    const messages = await runWithDirectData(() =>
      listMessages(params!.conversationId),
    );
    const latest = messages
      .filter((m) => m.direction === "INBOUND" && m.body !== "[送信取消]")
      .sort((a, b) =>
        (b.externalSentAt ?? b.createdAt).localeCompare(
          a.externalSentAt ?? a.createdAt,
        ),
      )[0];
    if (!latest || !byMessage.has(latest.id)) {
      await finishInquiry(
        state,
        owner,
        "STAFF_CONFIRMATION",
        "過去の通知を記録しました。最新の問い合わせを優先しています。",
        params.conversationId,
      );
      return { state: "RECORDED" };
    }
    params = byMessage.get(latest.id)!;
    // The target is the newest provider timestamp, not whichever event arrived last.
    const result = await processInquiryAndNotifyUnauthenticated({
      ...params,
      overrideInventoryId:
        state.overrideVersion === state.version
          ? state.overrideInventoryId
          : null,
      notifyStaff: settings.notifyStaff === true,
      isCurrent: () => stillCurrent(state, owner),
    });
    if (result.stale) {
      await releaseInquiry(state, owner);
      return { retrySeconds: 1, state: "STALE" };
    }
    if (result.technicalFailure) throw Error("DRAFT_PROCESSING_FAILED");
    const customerOnly = result.draft?.unresolvedFacts.every((f) =>
      /商品URL|商品名|注文番号|お届け先|都道府県|市区町村|階段.*幅|搬入経路/.test(
        f.field,
      ),
    );
    const outcome = params.skipGeneration
      ? "TECHNICAL_BLOCK"
      : !result.drafted
        ? "STAFF_CONFIRMATION"
        : result.draft?.unresolvedFacts.length
          ? customerOnly && !result.draft.evidence?.humanHandoff?.required
            ? "CUSTOMER_CONFIRMATION"
            : "STAFF_CONFIRMATION"
          : "ANSWERABLE";
    await finishInquiry(
      state,
      owner,
      outcome,
      result.reason,
      params.conversationId,
    );
    return { state: outcome };
  } catch (e) {
    await releaseInquiry(state, owner, true);
    throw e;
  }
}

import "server-only";
import {
  claimInquiry,
  eventsFor,
  finishInquiry,
  releaseInquiry,
  stillCurrent,
  inquirySettings,
  stateFor,
  getRuntimeRecord,
  type InboxEvent,
} from "./store";
import { receiveLine } from "./lineReceive";
import { processInquiryAndNotifyUnauthenticated } from "@/lib/inquiry/autoReply";
import { listMessages } from "@/lib/messaging/service";
import { runWithDirectData } from "@/lib/amplify/dataClient";
import {requestInquiryRead} from './readJobs';
import {enqueueCustomerDelivery} from './deliveryJobs';
import {CUSTOMER_DELIVERY_ENABLED} from '@/lib/messaging/featureState';

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
    const sourceKeys = new Map<string,string>();
    const toParams = async (item: InboxEvent) => {
      if(item.payload.channel !== "LINE") return item.payload.params;
      const stored = await receiveLine(item.payload.account, item.payload.event);
      return stored?.conversationId && stored.messageId ? {
        conversationId:stored.conversationId,sourceMessageId:stored.messageId,who:null,skipIfAlreadyNotified:true,
      } : null;
    };
    for (const item of events) {
      const received = await toParams(item);
      if(received) params=received;
      if (received?.sourceMessageId) {
        byMessage.set(received.sourceMessageId, received);
        sourceKeys.set(received.sourceMessageId,item.sk);
      }
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
    // Delayed older notifications must not replace the newest source context.
    if(latest && !byMessage.has(latest.id) && state.sourceEventSk) {
      const event = await getRuntimeRecord(pk,state.sourceEventSk) as InboxEvent|undefined;
      const previous = event?.payload ? await toParams(event) : null;
      if(previous?.sourceMessageId===latest.id && previous.conversationId===params.conversationId){
        byMessage.set(latest.id,previous);
        sourceKeys.set(latest.id,state.sourceEventSk);
      }
    }
    if (!latest || !byMessage.has(latest.id)) {
      await finishInquiry(
        state,
        owner,
        "TECHNICAL_BLOCK",
        "最新の問い合わせの取得情報を再確認する必要があります。過去の通知で回答を上書きしません。",
        params.conversationId,
      );
      return { state: "RECORDED" };
    }
    params = byMessage.get(latest.id)!;
    if(params.skipGeneration && params.mercariInquiryUrl){
      const read=await requestInquiryRead(state,latest.id,params.mercariInquiryUrl);
      if(read.status==='DONE'&&read.result){
        params={...params,skipGeneration:false,skipReason:null,verifiedRemote:read.result,
          productLookupHint:[params.productLookupHint,read.result.productId?`https://mercari-shops.com/products/${read.result.productId}`:null].filter(Boolean).join('\n')};
      }else{
        await finishInquiry(state,owner,'TECHNICAL_BLOCK',read.status==='BLOCKED'?'問い合わせ画面の取得が停止しています。確認用ブラウザの接続を確認して再試行してください。':'メールに本文がないため、問い合わせ画面の取得を待っています。',params.conversationId,sourceKeys.get(latest.id));
        return {state:'WAITING_FOR_READ'};
      }
    }
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
      sourceKeys.get(latest.id),
    );
    if(CUSTOMER_DELIVERY_ENABLED&&outcome==='ANSWERABLE'&&result.draft){
      const currentSettings=await inquirySettings();
      if(currentSettings.delivery?.mode==='AUTO')await runWithDirectData(()=>enqueueCustomerDelivery(pk,result.draft!.id,result.draft!.updatedAt,'AUTO',false));
    }
    return { state: outcome };
  } catch (e) {
    await releaseInquiry(state, owner, true);
    throw e;
  }
}

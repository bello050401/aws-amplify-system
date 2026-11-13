import {redactInquiryRecord} from '@/lib/messaging/contactPrivacy';

import {assertMessagesEnabled} from "@/lib/messaging/featureState";
import "server-only";
import { runWithDirectData } from "@/lib/amplify/dataClient";
import { getConversation, listMessages } from "@/lib/messaging/service";
import { notifyInquiry, type NotifyResult } from "@/lib/messaging/lineNotify/service";
import { buildDedupeKey } from "@/lib/messaging/lineNotify/deliveryPolicy";
import { findDeliveryByDedupeKey } from "@/lib/messaging/lineNotify/deliveryStore";
import { generateInquiryReplyDraft } from "./pipeline";
import { loadConversationContext, saveConversationContext } from "./contextStore";
import { addPendingQuestions, clearPendingQuestions, mergeConversationContext } from "./conversationContext";
import { saveReplyDraft,markReplyDraftStatus } from "./draftStore";
import {conversationStamp} from './runtime/policy';
import { getAIReplySettings } from "./settings";
import { rememberVerifiedReplies } from './replyHistoryIngest';
import { detectDeliveryDateIntent, evaluateDeliveryWindow, extractRequestedDeliveryDate } from "./deliveryWindow";
import type { DeliveryWindowState } from "./deliveryWindow";
import type { ReplyDraftRecord } from "./types";

/** Durable receive is completed before the private queue worker runs this pipeline. Stale conversations are checked before publishing drafts or staff notifications. */

export interface AutoReplyResult {
  stale?:boolean;
  technicalFailure?:boolean;
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
export function evaluateDeliveryState(messageText: string): DeliveryWindowState | null {
  if (!detectDeliveryDateIntent(messageText)) return null;
  const requested = extractRequestedDeliveryDate(messageText);
  if (!requested) return "DATE_INFO_REQUIRED";
  return evaluateDeliveryWindow({ purchaseDate: null, requestedDeliveryDate: requested }).state;
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
  /** Exact source link from the verified notification parser; never supplied by an LLM. */
  mercariInquiryUrl?: string | null;
  /** Verified auction identifier from the Yahoo question notification. No customer contact details. */
  yahooAuctionId?: string | null;
  /** Server-validated full transcript for mail notifications without a customer body. */
  verifiedRemote?: import('./runtime/readContract').ReadSnapshot;
  overrideInventoryId?:string|null;
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
  /**
   * 購入済み注文の情報(2026-09-04 追加指示 §54/§55)。
   * 会話文脈へ保持し、後続の短いメッセージでも注文と商品を失わない。
   */
  order?: import("./types").InquiryOrderInfo | null;
  /**
   * 商品情報の補完経路(§50)。注文番号からどう商品名へ辿り着いたかを
   * 社内通知の1通目へそのまま出す。
   */
  productContextNotes?: string[];
  /** Recheck the durable inbox version before publishing a generated draft. */
  isCurrent?:()=>Promise<boolean>;
  /** Evaluation records drafts only; it must never send a notification. */
  notifyStaff?:boolean;
}): Promise<AutoReplyResult> {
 params=redactInquiryRecord(params);
  assertMessagesEnabled();
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
    const initialStamp=conversationStamp(conversation,messages);
    const fresh=async()=>{
      if(params.isCurrent&&!await params.isCurrent())return false;
      const [current,currentMessages]=await Promise.all([getConversation(params.conversationId),listMessages(params.conversationId)]);
      return !!current&&conversationStamp(current,currentMessages)===initialStamp;
    };
    const staleResult:AutoReplyResult={drafted:false,draft:null,notify:null,reason:'新着または社員の操作があったため、古い返信案を公開せず再確認します。',stale:true};

    const target = params.sourceMessageId
      ? messages.find((m) => m.id === params.sourceMessageId && m.direction === "INBOUND")
      : [...messages].filter(m=>m.direction==='INBOUND'&&m.body!=='[送信取消]').sort((a,b)=>(b.externalSentAt??b.createdAt).localeCompare(a.externalSentAt??a.createdAt))[0];
    if (!target) {
      return { drafted: false, draft: null, notify: null, reason: "対象の受信メッセージが見つかりませんでした。" };
    }
    if(target.body==='[送信取消]')return {drafted:false,draft:null,notify:null,reason:'取り消されたメッセージです。'};
    const remoteMessages=params.verifiedRemote?.messages;
    await rememberVerifiedReplies({conversationId:conversation.id,channel:conversation.channel,messages,remote:params.verifiedRemote});
    const remoteTarget=remoteMessages?.filter(m=>m.speaker==='BUYER').at(-1);
    if(remoteMessages?.at(-1)?.speaker==='SELLER')return {drafted:false,draft:null,notify:null,reason:'取得した最新の会話では社員が返信済みです。'};
    if(remoteMessages&&!remoteTarget)return {drafted:false,draft:null,notify:null,reason:'お客様の問い合わせ本文を確認できません。'};
    if(conversation.lastOutgoingAt&&(target.externalSentAt??target.createdAt)<=conversation.lastOutgoingAt)return {drafted:false,draft:null,notify:null,reason:'この受信後に社員が返信済みです。'};

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

    const history = remoteTarget && remoteMessages ? remoteMessages.filter(m=>m!==remoteTarget).map(m=>({direction:m.speaker==='BUYER'?'INBOUND' as const:'OUTBOUND' as const,body:m.body})) : messages
      .filter((m) => m.id !== target.id&&m.body!=='[送信取消]')
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
          historySourceId: params.verifiedRemote?.inquiryId ?? conversation.externalConversationId ?? conversation.externalCustomerId,
          messageText: remoteTarget?.body ?? target.body,
          // 添付が実際にあったか。無いのに「お送りいただいた写真を確認し」と
          // 書く返信案が実機で出た(2026-09-03)。お客様は写真を送っていない
          // ので、返信を読んだ側は話が通じていないと受け取る。
          customerSentAttachment: target.attachmentStatus === "STORED",
          history,
          context: loadedContext.context,
          conversationInventoryId: conversation.relatedInventoryId,
          overrideInventoryId:params.overrideInventoryId??null,
          productLookupText: params.productLookupHint ?? null,
          productTitle: params.productTitle ?? null,
          additionalContext: params.additionalContext ?? null,
          order: params.order ?? null,
          productContextNotes: params.productContextNotes ?? [],
        });
      } catch (err) {
        // 生成の失敗で通知まで止めない(§34)。
        console.warn('[inquiry] generation failed', {code:err instanceof Error?err.name:'UNKNOWN'});
        return {drafted:false,draft:null,notify:null,technicalFailure:true,reason:'返信案を作成できませんでした。接続・予算・処理状態を確認してください。'};
      }
    }

    let draft: ReplyDraftRecord | null = null;
    if(!await fresh())return staleResult;
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
            evidence: {...generated.evidence,runtimeProof:{conversationStamp:initialStamp,generatedAt:new Date().toISOString()}},
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
        console.error("[autoReply] DRAFT_SAVE_FAILED");
        throw Error('返信案を保存できませんでした。');
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
      if(!await fresh()){if(draft)await markReplyDraftStatus(draft.id,'DISMISSED',params.who);return staleResult;}
      const saved = await saveConversationContext(conversation.id, (current) => {
        if(current.version!==loadedContext.context.version)return current;
        // current は競合時に読み直された最新値。そこへ**今回分かったことを
        // 足す**形で書く(上書きしない)。
        const merged = mergeConversationContext(current, {
          channel: result.context.channel,
          identifiedProduct: result.context.identifiedProduct,
          negotiation: result.context.negotiation,
          shipping: result.context.shipping,
          order: result.context.order,
          intents: result.context.intents,
          knowledgeDocumentIds: result.context.knowledgeDocumentIds,
          reviewReasons: result.context.reviewReasons,
        });
        // 確認待ちは「解消した項目を落として、今回尋ねた項目を足す」。
        // 今回の結果でまるごと置き換えると、競合してやり直したときに
        // **相手が尋ねた確認事項を消してしまう**。差分で書けば、
        // 何度やり直しても同じ結果になる。
        return addPendingQuestions(
          clearPendingQuestions(merged, result.resolvedPendingFields),
          result.askedPendingQuestions,
        );
      });
      if (!saved.saved && saved.reason) contextIssues.push(saved.reason);
    }

    // ── 通知 ──────────────────────────────────────────────────
    if(!await fresh()){if(draft)await markReplyDraftStatus(draft.id,'DISMISSED',params.who);return staleResult;}
    if(params.notifyStaff===false)return {drafted:Boolean(generated?.draftText),draft,notify:null,reason:failureReason??'返信案を保存しました。評価モードのため通知していません。'};
    const notify = await notifyInquiry({
      conversationId: conversation.id,
      sourceMessageId: target.id,
      channel: conversation.channel,
      customerName: conversation.customerDisplayName,
      messageText: remoteTarget?.body ?? target.body,
      intents: generated?.intents ?? [],
      evidence: generated?.evidence ?? null,
      draftText: generated?.draftText ?? null,
      replyDraftId: draft?.id ?? null,
      draftStatus: generated?.status ?? null,
      deliveryWindowState: evaluateDeliveryState(remoteTarget?.body ?? target.body),
      // §27 引き継いだ情報を1通目に出す。「埼玉です」だけを見せられても
      // 担当者は判断できない。
      carriedFacts: generated?.carriedFacts ?? [],
      answeredQuestions: generated?.answeredQuestions ?? [],
      // 生成まで進めなかった場合(§3 本文が取れない等)でも、注文番号から
      // 商品名をどう復元したかは担当者にとって判断材料になる。
      productContextNotes: generated?.productContextNotes ?? params.productContextNotes ?? [],
      // §58 商品Contextを復元できたら、社内通知にも商品情報を出す。
      // evidence が無い経路(生成をしなかった場合)でも出せるよう、
      // 生成結果とは別に渡す。
      orderProduct:
        params.order && params.order.productName
          ? { productName: params.order.productName, orderId: params.order.orderId }
          : null,
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
    console.error("[autoReply] PROCESSING_FAILED");
    return { drafted: false, draft: null, notify: null, reason: '問い合わせ処理に失敗しました。再試行します。',technicalFailure:true };
  }
}

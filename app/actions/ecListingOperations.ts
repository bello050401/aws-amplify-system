"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  canEditInventory,
  getInventoryRole,
  getCurrentInventoryUserEmail,
} from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing, getListingDraftForInventory, saveListingDraft } from "@/lib/listing/service";
import { EC_CHANNELS, type EcChannel, type EcOperation, type EcReview } from "@/lib/listing/ecManagement";
import {
  getMercariHttpListingStateAction,
  publishMercariHttpListingAction,
  reopenMercariHttpListingAction,
  stopMercariHttpListingAction,
} from "./mercariWebHttpLifecycle";
import { getMercariWebHttpDraftJobStatusAction } from "./mercariWebHttpDraftJob";
import { executeMercariHttpDraftStepAction } from "./mercariWebHttpExecuteDraft";
import { getYahooAuctionPreparationAction } from "./yahooAuctionPreparation";
import {
  getYahooWorkflowAction,
  prepareYahooPublicationAction,
  publishYahooListingAction,
  cancelYahooListingAction,
} from "./yahooAuctionWorkflow";
import { reviewBaseListing, executeBaseListing } from "@/lib/listing/base/manualLifecycle";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const messages: Record<string, string> = {
  WAIT_INTERVAL: "販売先への送信間隔を空けています。",
  AUTH_REQUIRED: "販売先のログインが切れています。出品設定から接続を確認してください。",
  FORBIDDEN: "この販売先を操作する権限がありません。",
  NOT_CONFIGURED: "販売先の接続設定を確認してください。",
  SOURCE_CHANGED: "商品情報が変わりました。内容を保存してから確認し直してください。",
  INVALID_INPUT: "出品価格・数量・カテゴリ・終了日時などを商品編集で確認してください。",
  NOT_ELIGIBLE: "在庫数または販売状況を確認してください。",
  FIXED_PRICE_ONLY: "ヤフオクは定額販売の出品に対応しています。",
  BIDS_OR_STATE_CHANGED: "入札または出品状態が変わったため、停止していません。",
  CANCELLATION_FEE_OR_FORM_CHANGED: "取消料金なしを確認できないため、停止していません。",
  APPROVAL_MISMATCH: "確認内容が変わりました。もう一度確認してください。",
  CONFIRMATION_EXPIRED: "確認の有効期限が切れました。もう一度確認してください。",
};
function message(code: string) {
  return (
    messages[code] ??
    "処理結果を確定できません。販売先と送信結果を確認してください。重複送信は行っていません。"
  );
}
async function archivedDraft(id: string) {
  const r = await serverDataClient.models.ListingDraft.listListingDraftByInventoryId(
    { inventoryId: id },
    { ...inventoryAuthMode },
  );
  if (r.errors) throw Error("DRAFT_READ_FAILED");
  return [...r.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** A bounded, one-product step. The client queues products; no unbounded server job or automatic retry of uncertain writes. */
export async function reviewEcListingAction(
  id: string,
  channel: EcChannel,
  operation: EcOperation,
): Promise<EcReview> {
  const base: EcReview = {
    inventoryId: id,
    channel,
    operation,
    title: "",
    status: "BLOCKED",
    message: "操作を確認できませんでした。",
  };
  if (
    !validId(id) ||
    !EC_CHANNELS.includes(channel) ||
    !["PUBLISH", "STOP", "ARCHIVE", "RESTORE"].includes(operation) ||
    !canEditInventory(await getInventoryRole())
  )
    return base;
  try {
    const item = await getInventoryDetail(id);
    if (!item) return { ...base, message: "対象商品が見つかりません。" };
    base.title = item.name;
    if (operation === "ARCHIVE" || operation === "RESTORE") {
      const draft = await archivedDraft(id);
      if ((operation === "ARCHIVE" && draft?.deletedAt) || (operation === "RESTORE" && !draft?.deletedAt))
        return {
          ...base,
          status: "DONE",
          message: operation === "ARCHIVE" ? "削除済みです。" : "復元済みです。",
        };
      return {
        ...base,
        status: "READY",
        token: digest([id, operation, draft?.id, draft?.updatedAt, item.updatedAt]),
        message:
          operation === "ARCHIVE"
            ? "EC一覧から削除します。在庫と販売先の商品は残ります。"
            : "EC一覧に戻します。",
        details:
          operation === "ARCHIVE"
            ? [
                "出品中の商品を止める場合は、先に販売先を選び「出品停止」を実行してください。",
                "削除後は「削除済み」から復元できます。",
              ]
            : [],
      };
    }
    const common = await getListingDraftForInventory(id);
    if (operation === "PUBLISH" && !common)
      return { ...base, message: "共通の商品情報を保存してから出品してください。" };
    if (channel === "BASE") return { ...base, ...(await reviewBaseListing(id, operation)) };
    if (channel === "YAHOO") {
      const current = await getYahooWorkflowAction(id);
      if (!current.ok) return { ...base, message: message(current.code) };
      if (operation === "STOP") {
        if (!current.view.listing || current.view.listing.remoteStatus !== "open")
          return { ...base, status: "DONE", message: "出品中の商品はありません。" };
        return {
          ...base,
          status: "READY",
          token: current.view.listing.auctionId,
          title: current.view.listing.title,
          price: current.view.listing.priceYen,
          quantity: current.view.listing.quantity,
          message: "入札と取消料金がないことを確認して停止します。",
        };
      }
      if (current.view.listing?.remoteStatus === "open")
        return { ...base, status: "DONE", message: "すでに出品中です。" };
      const prep = await getYahooAuctionPreparationAction(id);
      if (!prep.ok || !prep.context.saved)
        return { ...base, message: "ヤフオクの出品情報を商品編集で保存してください。" };
      const prepared = await prepareYahooPublicationAction(id, prep.context.saved.revision);
      if (!prepared.ok)
        return {
          ...base,
          status: prepared.code === "WAIT_INTERVAL" ? "WAIT" : "BLOCKED",
          nextAt: prepared.waitUntil,
          message: message(prepared.code),
        };
      const view = prepared.view;
      if (view.stage === "PREPARING")
        return {
          ...base,
          status: "WAIT",
          nextAt: Math.max(Date.now() + 1000, view.waitUntil),
          message: `画像を準備中（${view.uploaded} / ${view.imageCount}枚）`,
        };
      if (!view.confirmation || !view.confirmationId)
        return { ...base, message: message(view.error ?? "UNKNOWN") };
      return {
        ...base,
        status: "READY",
        token: view.confirmationId,
        title: view.confirmation.title,
        price: view.confirmation.priceYen,
        quantity: view.confirmation.quantity,
        imageCount: view.imageCount,
        requiresTerms: true,
        message: view.confirmation.relist
          ? "再出品する内容を確認してください。"
          : "出品する内容を確認してください。",
        details: [
          view.confirmation.category,
          view.confirmation.shipping,
          `終了日時：${view.confirmation.endAtJst.replace("T", " ")}（日本時間）`,
        ],
      };
    }
    const state = await getMercariHttpListingStateAction(id);
    if (!["LISTED", "STOPPED", "DRAFT_READY"].includes(state.status)) {
      const legacy = await getChannelListing(id, "MERCARI_SHOPS");
      if (legacy?.externalListingId)
        return {
          ...base,
          message: "登録済みのメルカリShops商品があります。出品設定で既存商品の対応を確認してください。",
        };
    }
    if (operation === "STOP") {
      if (state.status === "STOPPED" || state.status === "NOT_PREPARED" || state.status === "DRAFT_READY")
        return { ...base, status: "DONE", message: "出品中の商品はありません。" };
      if (state.status !== "LISTED" || !state.productId) return { ...base, message: message(state.status) };
      return {
        ...base,
        status: "READY",
        token: state.productId,
        message: "メルカリShopsの商品を非公開にします。",
      };
    }
    if (state.status === "LISTED") return { ...base, status: "DONE", message: "すでに出品中です。" };
    if (state.status === "NOT_PREPARED")
      return { ...base, message: "メルカリShopsの価格・数量・カテゴリを商品編集で保存してください。" };
    if (state.status === "PREPARED") {
      const job = await getMercariWebHttpDraftJobStatusAction(id);
      if (!job.ok || !job.requestId)
        return { ...base, message: "メルカリShopsの出品情報を確認してください。" };
      const step = await executeMercariHttpDraftStepAction(job.requestId);
      if (["CONTINUE", "WAIT_INTERVAL", "DRAFT_READY"].includes(step.status))
        return {
          ...base,
          status: "WAIT",
          nextAt: Math.max(Date.now() + 1000, step.nextEligibleAtMs ?? 0),
          message: "出品画像と商品情報を準備しています。",
        };
      return { ...base, message: message(step.status) };
    }
    if (state.status !== "STOPPED" && state.status !== "DRAFT_READY")
      return { ...base, message: message(state.status) };
    const result = await (
      state.status === "STOPPED" ? reopenMercariHttpListingAction : publishMercariHttpListingAction
    )(id, null);
    if (result.status === "WAIT_INTERVAL")
      return {
        ...base,
        status: "WAIT",
        nextAt: result.nextEligibleAtMs ?? Date.now() + 30000,
        message: "送信間隔を空けています。",
      };
    if (!result.preview || result.status !== "READY_FOR_CONFIRMATION")
      return { ...base, message: message(result.status) };
    return {
      ...base,
      status: "READY",
      token: `${state.status}:${result.preview.digest}`,
      title: result.preview.title,
      price: result.preview.priceYen,
      quantity: result.preview.quantity,
      imageCount: result.preview.imageCount,
      message: "出品する内容を確認してください。",
    };
  } catch {
    return { ...base, message: "情報を取得できませんでした。接続を確認してやり直してください。" };
  }
}

export async function executeEcListingAction(
  review: EcReview,
  confirmed: boolean,
  termsAccepted = false,
): Promise<EcReview> {
  const failed: EcReview = {
    ...review,
    token: undefined,
    status: "BLOCKED",
    message: "操作を完了できませんでした。結果を確認してください。",
  };
  if (
    !confirmed ||
    !review.token ||
    review.token.length > 300 ||
    !validId(review.inventoryId) ||
    !EC_CHANNELS.includes(review.channel) ||
    !["PUBLISH", "STOP", "ARCHIVE", "RESTORE"].includes(review.operation) ||
    !canEditInventory(await getInventoryRole())
  )
    return failed;
  const id = review.inventoryId;
  try {
    if (review.operation === "ARCHIVE" || review.operation === "RESTORE") {
      const check = await reviewEcListingAction(id, review.channel, review.operation);
      if (check.status === "DONE") return check;
      if (check.status !== "READY" || check.token !== review.token)
        return { ...failed, message: "商品情報が変わりました。削除・復元の確認をやり直してください。" };
      const who = await getCurrentInventoryUserEmail();
      let draft = await archivedDraft(id);
      if (!draft) {
        const item = await getInventoryDetail(id);
        if (!item) return failed;
        const saved = await saveListingDraft(
          id,
          { title: item.name, description: "", price: 0, condition: "NO_NOTABLE_DAMAGE" },
          who,
        );
        const read = await serverDataClient.models.ListingDraft.get({ id: saved.id }, inventoryAuthMode);
        if (read.errors || !read.data) return failed;
        draft = read.data;
      }
      const r = (await serverDataClient.graphql({
        query: `mutation ArchiveEcDraft($input:UpdateListingDraftInput!, $condition:ModelListingDraftConditionInput) { updateListingDraft(input:$input,condition:$condition) { id deletedAt } }`,
        variables: {
          input: {
            id: draft.id,
            deletedAt: review.operation === "ARCHIVE" ? new Date().toISOString() : null,
            updatedBy: who,
          },
          condition: { updatedAt: { eq: draft.updatedAt } },
        },
        authMode: "userPool",
      })) as { errors?: unknown; data?: { updateListingDraft?: { id: string } } };
      if (r.errors || !r.data?.updateListingDraft)
        return { ...failed, message: "保存内容が変わりました。再確認してください。" };
    } else if (review.channel === "BASE") {
      const result = await executeBaseListing(id, review.operation, review.token);
      if (!result.ok) return { ...failed, message: result.message };
    } else if (review.channel === "YAHOO") {
      const r =
        review.operation === "STOP"
          ? await cancelYahooListingAction(id, review.token)
          : await publishYahooListingAction(id, review.token, termsAccepted);
      if (!r.ok)
        return {
          ...failed,
          status: r.code === "WAIT_INTERVAL" ? "WAIT" : "BLOCKED",
          token: review.token,
          nextAt: r.waitUntil,
          message: message(r.code),
        };
      if (r.view.listing?.remoteStatus !== (review.operation === "STOP" ? "cancelled" : "open"))
        return { ...failed, message: message(r.view.error ?? "UNKNOWN") };
    } else if (review.operation === "STOP") {
      const state = await getMercariHttpListingStateAction(id);
      if (state.productId !== review.token)
        return { ...failed, message: "出品先が変わりました。停止の確認をやり直してください。" };
      const r = await stopMercariHttpListingAction(id);
      if (!r.stopConfirmed)
        return {
          ...failed,
          status: r.status === "WAIT_INTERVAL" ? "WAIT" : "BLOCKED",
          token: review.token,
          nextAt: r.nextEligibleAtMs ?? undefined,
          message: message(r.status),
        };
    } else {
      const [kind, token] = review.token.split(":");
      if (kind !== "STOPPED" && kind !== "DRAFT_READY") return failed;
      const r = await (kind === "STOPPED" ? reopenMercariHttpListingAction : publishMercariHttpListingAction)(
        id,
        token,
      );
      if (r.status !== "PUBLISHED" && r.status !== "EXISTING_PRODUCT")
        return {
          ...failed,
          status: r.status === "WAIT_INTERVAL" ? "WAIT" : "BLOCKED",
          token: review.token,
          nextAt: r.nextEligibleAtMs ?? undefined,
          message: message(r.status),
        };
    }
    revalidatePath("/inventory/listings");
    revalidatePath(`/inventory/${id}/listing`);
    return {
      ...review,
      status: "DONE",
      token: undefined,
      message:
        review.operation === "ARCHIVE"
          ? "EC一覧から削除しました。"
          : review.operation === "RESTORE"
            ? "EC一覧に復元しました。"
            : review.operation === "STOP"
              ? "出品停止を確認しました。"
              : "出品を確認しました。",
    };
  } catch {
    return failed;
  }
}

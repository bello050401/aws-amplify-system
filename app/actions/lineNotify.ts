"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { validateNotifyBotConnection } from "@/lib/messaging/lineNotify/client";
import {
  clearNotifyBotConnectionInSecretsManager,
  getNotifyBotTokenSource,
  setNotifyBotConnectionInSecretsManager,
  type NotifyBotTokenSource,
} from "@/lib/messaging/lineNotify/secretStore";
import {
  getLineNotifySettings,
  saveNotifyBotProfile,
  type LineNotifySettings,
} from "@/lib/messaging/lineNotify/settingsStore";
import { listRecentDeliveries, type NotificationDeliveryRecord } from "@/lib/messaging/lineNotify/deliveryStore";
import { getReplyDraft } from "@/lib/inquiry/draftStore";
import type { IdentifiedProductCard } from "@/lib/inquiry/types";
import { resendWaitingDeliveries, retryDelivery, sendTestNotification } from "@/lib/messaging/lineNotify/service";

/**
 * 2026-09-03 指示書 §6/§35: 社内通知Botの設定・接続確認・テスト送信。
 *
 * app/actions/lineSecret.ts と同じ方針:
 *   - ADMIN限定
 *   - **戻り値にTOKEN本体を一切含めない**(§6-1「値そのものをログへ出さない」)
 *   - 保存前に実際のLINE APIで疎通確認し、失敗したら既存の設定を壊さない
 */
async function requireAdmin(): Promise<void> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("この操作にはADMIN権限が必要です。");
}

/** 画面表示・テスト送信は EDITOR も使える(運用担当が接続状態を見られる必要がある)。 */
async function requireEditor(): Promise<void> {
  const role = await getInventoryRole();
  if (role !== "ADMIN" && role !== "EDITOR") throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
}

export interface NotifyBotActionResult {
  success: boolean;
  message: string;
}

/** §6 画面に出す接続状態。トークンは含めない。 */
export interface NotifyBotStatus {
  tokenSource: NotifyBotTokenSource;
  connected: boolean;
  settings: LineNotifySettings;
  /** 通知先が登録されているか。未登録なら送信できない。 */
  hasTarget: boolean;
}

export async function getNotifyBotStatusAction(): Promise<NotifyBotStatus> {
  await requireEditor();
  const [tokenSource, settings] = await Promise.all([getNotifyBotTokenSource(), getLineNotifySettings()]);
  return {
    tokenSource,
    connected: tokenSource !== "unconfigured",
    settings,
    hasTarget: Boolean(settings.targetUserId),
  };
}

export async function setNotifyBotConnectionAction(params: {
  channelSecret: string;
  accessToken: string;
}): Promise<NotifyBotActionResult> {
  await requireAdmin();
  const channelSecret = params.channelSecret.trim();
  const accessToken = params.accessToken.trim();
  if (!channelSecret) return { success: false, message: "Channel Secretを入力してください。" };
  if (!accessToken) return { success: false, message: "Channel Access Tokenを入力してください。" };

  // 先に疎通確認する。検証せずに保存すると、間違ったトークンが入ったまま
  // 「設定済み」と表示され、実際の問い合わせが来たときに初めて失敗する。
  const validation = await validateNotifyBotConnection(accessToken);
  if (!validation.ok) return { success: false, message: validation.message };

  try {
    await setNotifyBotConnectionInSecretsManager({ channelSecret, accessToken });
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "保存に失敗しました。" };
  }

  // Bot名と友だち追加URLは接続確認のついでに取れる。QRを別途用意しなくても
  // 案内できるようにしておく(§4-3 未設定でも壊れた画像を出さない)。
  try {
    await saveNotifyBotProfile({
      botDisplayName: validation.info?.displayName ?? null,
      addFriendUrl: validation.info?.basicId ? `https://line.me/R/ti/p/${validation.info.basicId}` : null,
    });
  } catch (err) {
    // 表示用情報の保存に失敗しても、接続設定そのものは保存できている。
    console.warn("[lineNotify] Bot情報の保存に失敗しました", err instanceof Error ? err.message : String(err));
  }

  revalidatePath("/inventory/settings");
  revalidatePath("/inventory/messages");
  return { success: true, message: `${validation.message} 次に、QRコードから友だち追加してください。` };
}

export async function deleteNotifyBotConnectionAction(): Promise<NotifyBotActionResult> {
  await requireAdmin();
  try {
    await clearNotifyBotConnectionInSecretsManager();
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "削除に失敗しました。" };
  }
  revalidatePath("/inventory/settings");
  revalidatePath("/inventory/messages");
  return { success: true, message: "社内通知Botの接続設定を削除しました。" };
}

/** §4-3 QR画像は差し替え可能にする。コードへベタ書きしない。 */
export async function saveNotifyBotDisplayAction(params: {
  qrImageUrl: string;
  addFriendUrl: string;
}): Promise<NotifyBotActionResult> {
  await requireAdmin();
  try {
    await saveNotifyBotProfile({
      qrImageUrl: params.qrImageUrl.trim() || null,
      addFriendUrl: params.addFriendUrl.trim() || null,
    });
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "保存に失敗しました。" };
  }
  revalidatePath("/inventory/messages");
  return { success: true, message: "友だち追加の案内を保存しました。" };
}

/** §35 テスト送信。本番のInquiryを作らない(service.ts のコメント参照)。 */
export async function sendTestNotificationAction(): Promise<NotifyBotActionResult> {
  await requireEditor();
  const result = await sendTestNotification();
  revalidatePath("/inventory/messages");
  return { success: result.ok, message: result.message };
}

export async function listRecentDeliveriesAction(limit = 50): Promise<NotificationDeliveryRecord[]> {
  await requireEditor();
  return listRecentDeliveries(limit);
}

/**
 * 通知1件の根拠(§24「使用ルール」「使用ナレッジ」「対象商品」)。
 *
 * 一覧では返さない。50件分の evidence を毎回読むと重く、しかも大半は
 * 開かれない —— 展開したときだけ引く。
 */
export async function getDeliveryEvidenceAction(replyDraftId: string): Promise<{
  identifiedProduct: IdentifiedProductCard | null;
  knowledgeDocuments: { id: string; title: string; fileName: string }[];
  appliedReplyRules: { id: string; title: string; category: string; version: number }[];
  productCandidates: { displayInventoryId: string; name: string; confidence: number }[];
  modelName: string | null;
  status: string | null;
} | null> {
  await requireEditor();
  const draft = await getReplyDraft(replyDraftId);
  if (!draft) return null;
  return {
    identifiedProduct: draft.evidence?.identifiedProduct ?? null,
    knowledgeDocuments: draft.evidence?.knowledgeDocuments ?? [],
    appliedReplyRules: draft.evidence?.appliedReplyRules ?? [],
    productCandidates: (draft.evidence?.productCandidates ?? []).map((c) => ({
      displayInventoryId: c.displayInventoryId,
      name: c.name,
      confidence: c.confidence,
    })),
    modelName: draft.modelName,
    status: draft.status,
  };
}

/**
 * 通知先の登録待ちだったものをまとめて送る(§7)。
 *
 * 友だち追加の直後に使う。**古いものを一気に送らない**よう、件数と期間の
 * 上限は service 側が持っている。
 */
export async function resendWaitingDeliveriesAction(): Promise<NotifyBotActionResult> {
  await requireEditor();
  const r = await resendWaitingDeliveries();
  revalidatePath("/inventory/messages");
  return { success: r.failed === 0 && r.sent > 0, message: r.message };
}

/** 失敗・停止した通知の手動再送。原因を直した後に人が流せるようにする。 */
export async function retryDeliveryAction(deliveryId: string): Promise<NotifyBotActionResult> {
  await requireEditor();
  const result = await retryDelivery(deliveryId);
  revalidatePath("/inventory/messages");
  return { success: result.sent, message: result.reason };
}

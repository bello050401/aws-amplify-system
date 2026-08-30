"use server";

import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { generateListingCopy, generateReplyDraft, type ListingCopyResult } from "@/lib/ai/ecCopy";
import { getConversation, listMessages } from "@/lib/messaging/service";
import { getChannelListing } from "@/lib/listing/service";

/**
 * BELLO統合業務OS指示書(2026-08-30) §56/§88-90: AI生成のServer Action層。
 * §89: 一覧を開いただけでAI requestしない — このファイルの関数は
 * すべてUIの明示的なボタン操作からのみ呼ばれる(自動実行される経路は
 * 無い)。書き込み権限(canEditInventory)を要求するのは、生成結果を
 * 実際に使う(下書きへ反映する)操作が編集操作だから — 生成そのものは
 * Inventory/Listing/Conversationのどれも書き込まない(読み取り専用)。
 */
async function requireEditPermission(): Promise<void> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
}

/**
 * §57: Inventoryの事実情報のみをAIへ渡す — adminMemo(自社内での連絡
 * 事項)はこの関数が一切読み書きしていないことがその境界の証拠。
 */
export async function generateListingCopyAction(inventoryId: string): Promise<ListingCopyResult> {
  await requireEditPermission();
  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");

  return generateListingCopy({
    name: inventory.name,
    dimensions: [inventory.width, inventory.depth, inventory.height].filter(Boolean).length
      ? `幅${inventory.width ?? "-"} × 奥行${inventory.depth ?? "-"} × 高さ${inventory.height ?? "-"} (cm)`
      : null,
    conditionNote: inventory.conditionRating,
    note: inventory.note,
  });
}

export async function generateReplyDraftAction(conversationId: string): Promise<string> {
  await requireEditPermission();
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new Error("対象の会話が見つかりません。");
  const messages = await listMessages(conversationId);
  const latestIncoming = [...messages].reverse().find((m) => m.direction === "INBOUND");
  if (!latestIncoming) throw new Error("返信対象となる受信メッセージがありません。");

  const inventory = conversation.relatedInventoryId ? await getInventoryDetail(conversation.relatedInventoryId) : null;
  // §69: 送料は必ず事前計算済みの確定値のみをAIへ渡す(AIに暗算させない)。
  // confirmedShippingFee(人が確認した値)を最優先し、無ければ
  // calculatedShippingFee(自動見積り)、どちらも無ければnull —
  // generateReplyDraft側のsystem promptが「未確定の場合は具体的な金額
  // を言わない」よう指示する。
  const channelListing = conversation.relatedInventoryId ? await getChannelListing(conversation.relatedInventoryId, "MERCARI_SHOPS") : null;
  const shippingFee = channelListing?.confirmedShippingFee ?? channelListing?.calculatedShippingFee ?? null;

  return generateReplyDraft({
    channel: conversation.channel,
    inquiryBody: latestIncoming.body,
    productName: inventory?.name ?? null,
    productCondition: inventory?.conditionRating ?? null,
    sellingPrice: inventory?.salePrice ?? inventory?.plannedSalePrice ?? null,
    stockQuantity: inventory?.quantity ?? null,
    shippingFee,
    conversationHistory: messages.slice(-10).map((m) => ({ direction: m.direction, body: m.body })),
  });
}

"use server";

import { randomUUID } from "node:crypto";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { generateListingCopy, generateReplyDraft, type ListingCopyResult } from "@/lib/ai/ecCopy";
import { buildCustomerSafeFacts } from "@/lib/ai/productIntro/facts";
import { getConversation, listMessages } from "@/lib/messaging/service";
import { getChannelListing } from "@/lib/listing/service";

/**
 * BELLO統合業務OS指示書(2026-08-30) §56/§88-90: AI生成のServer Action層。
 * §89: 一覧を開いただけでAI requestしない — このファイルの関数は
 * すべてUIの明示的なボタン操作からのみ呼ばれる(自動実行される経路は
 * 無い)。書き込み権限(canEditInventory)を要求するのは、生成結果を
 * 実際に使う(下書きへ反映する)操作が編集操作だから — 生成そのものは
 * Inventory/Listing/Conversationのどれも書き込まない(読み取り専用)。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 第六ラウンド P0-1: AI自動下書き Server Components render error 根本修復
 *
 * 【再現した実際の現象】production build(`next build && next start`)
 * では、Server Action(`"use server"`関数)が`throw new Error("...")`
 * すると、Next.js自身が本文メッセージを問答無用でマスクし、クライアント
 * 側の`catch (err) { err.message }`には常に一言一句この文字列が渡る
 * ——実際にPlaywrightでproduction buildを起動し検証済み(下記参照):
 *   "An error occurred in the Server Components render. The specific
 *   message is omitted in production builds to avoid leaking sensitive
 *   details. A digest property is included on this error instance..."
 * これはこのアプリのバグではなくNext.js 14自身の意図的な仕様(Server
 * Actionからthrowされた値のmessageは、production buildでは常に安全側
 * に丸められる)。dev modeでは再現しない——本ラウンド仕様書が
 * 「dev modeだけ直して終了しない」と明記する通り、まさにこの差異が
 * 原因で見過ごされていた。
 *
 * 【根本修正方針】「エラーをthrowしてクライアントへ運ぶ」設計自体を
 * やめ、Server Action は例外を必ずこの関数内でcatchし、
 * `{ok:true,...} | {ok:false,error,correlationId}`という
 * シリアライズ可能な**戻り値**として返す(Next.js公式ドキュメントが
 * 推奨する「Server Actionのエラーはthrowでなくreturnで伝える」パターン)。
 * これによりNext.jsのmasking機構自体を経由しなくなり、
 * `requireEditPermission`/`getInventoryDetail`/`generateListingCopy`
 * (Anthropic API key未設定・provider timeout等)が投げる、元々secretを
 * 含まない安全な日本語メッセージ(このリポジトリ全体の既存の設計方針
 * ——describeAnthropicError等が徹底している)がそのままユーザーへ届く。
 *
 * 元の例外の詳細(スタック・digest相当のcorrelationId)はサーバー側の
 * structured logへ必ず記録する——「try/catchで隠すだけ」ではなく、
 * 見えなくなる情報は全てログに残す。
 */
function logActionFailure(action: string, correlationId: string, context: Record<string, unknown>, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      action,
      correlationId,
      timestamp: new Date().toISOString(),
      context,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
}

/** err.messageが常に安全(secretを含まない)であることは、このリポジトリの既存方針(describeAnthropicError等)が前提——Errorでない値だけ汎用文言にフォールバックする。 */
function safeErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

async function requireEditPermission(): Promise<void> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
}

export type GenerateListingCopyActionResult = { ok: true; data: ListingCopyResult } | { ok: false; error: string; correlationId: string };

/**
 * §57: Inventoryの事実情報のみをAIへ渡す — adminMemo(自社内での連絡
 * 事項)はこの関数が一切読み書きしていないことがその境界の証拠。
 */
export async function generateListingCopyAction(inventoryId: string): Promise<GenerateListingCopyActionResult> {
  const correlationId = randomUUID();
  try {
    await requireEditPermission();
    const inventory = await getInventoryDetail(inventoryId);
    if (!inventory) throw new Error("対象の在庫が見つかりません。");

    // 【2026-09-01】以前はここで inventory.conditionRating と
    // inventory.note を**そのまま**AIへ渡していた。本番データを実測した
    // 結果、その2つは顧客向けの生成に渡してよい値ではなかった:
    //
    //   - conditionRating の実態は社内の5段階スコア("3.5"/"4"/"3"…)。
    //     これを「コンディション: 4」として渡していたため、モデルは
    //     忠実に「コンディションは4です」と書いていた。顧客へ開示すべき
    //     状態説明は damageNotes 側にあるのに、そちらは渡していなかった。
    //   - note には顧客の配送先住所が入っている行がある(実測300件中2件)。
    //     生成結果は公開される商品説明なので、他人の住所が載り得た。
    //
    // buildCustomerSafeFacts が、社内スコアの除去・個人情報らしき記述の
    // 除去・寸法の整形をまとめて行う。落とした項目は redactions として
    // 返るので、サーバーログにだけ残す(顧客にもUIにも出さない)。
    const { facts, redactions } = buildCustomerSafeFacts({
      name: inventory.name,
      width: inventory.width,
      depth: inventory.depth,
      height: inventory.height,
      conditionRating: inventory.conditionRating,
      damageNotes: inventory.damageNotes,
      note: inventory.note,
    });
    if (redactions.length > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          action: "generateListingCopyAction",
          correlationId,
          message: "AIへ渡す前に除外した項目があります",
          inventoryId,
          redactions,
        }),
      );
    }

    const data = await generateListingCopy({
      name: facts.name,
      dimensions: facts.dimensions,
      categoryName: facts.categoryName,
      conditionNote: facts.conditionDisclosure,
      note: facts.publicNote,
      // 生成後の機械検査が「出てはいけない値」として使う。
      guard: { stockQuantity: inventory.quantity, sku: inventory.sku },
    });
    return { ok: true, data };
  } catch (err) {
    logActionFailure("generateListingCopyAction", correlationId, { inventoryId }, err);
    return { ok: false, error: safeErrorMessage(err, "AI下書きの生成に失敗しました。時間をおいて再試行してください。"), correlationId };
  }
}

export type GenerateReplyDraftActionResult = { ok: true; data: string } | { ok: false; error: string; correlationId: string };

export async function generateReplyDraftAction(conversationId: string): Promise<GenerateReplyDraftActionResult> {
  const correlationId = randomUUID();
  try {
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

    // 返信案も顧客が読む文章なので、出品コピーと同じ理由で
    // conditionRating(社内の5段階スコア)をそのまま渡さない。
    // 「コンディションは4です」と返信してしまう経路をここでも塞ぐ。
    const replyFacts = inventory
      ? buildCustomerSafeFacts({
          name: inventory.name,
          conditionRating: inventory.conditionRating,
          damageNotes: inventory.damageNotes,
        }).facts
      : null;

    const data = await generateReplyDraft({
      channel: conversation.channel,
      inquiryBody: latestIncoming.body,
      productName: inventory?.name ?? null,
      productCondition: replyFacts?.conditionDisclosure ?? null,
      sellingPrice: inventory?.salePrice ?? inventory?.plannedSalePrice ?? null,
      stockQuantity: inventory?.quantity ?? null,
      shippingFee,
      conversationHistory: messages.slice(-10).map((m) => ({ direction: m.direction, body: m.body })),
    });
    return { ok: true, data };
  } catch (err) {
    logActionFailure("generateReplyDraftAction", correlationId, { conversationId }, err);
    return { ok: false, error: safeErrorMessage(err, "AI返信案の生成に失敗しました。時間をおいて再試行してください。"), correlationId };
  }
}

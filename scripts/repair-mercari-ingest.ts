/**
 * 2026-09-03 追加指示 §10: 本文抽出の不具合で作られたメルカリ取り込みの修復。
 *
 * ── 何が起きたか ────────────────────────────────────────────────
 *
 * 修正前の取り込みには2つの不具合があった。
 *
 *   1. 検索条件が `from:mercari` で、mercari.jp のキャンペーン・新着通知・
 *      サポート返信・HubSpot配信まで会話として取り込んでいた
 *   2. 顧客本文を抽出できず、件名と商品名だけを材料にAIが分類していた
 *      (実例では「素材」と誤分類し、商品URLの再送を顧客へ依頼する
 *       返信案まで生成していた)
 *
 * ── 方針: 消さない ──────────────────────────────────────────────
 *
 * §10「不可逆な一括削除はしない」。このスクリプトは**通知を SUPERSEDED に
 * するだけ**で、Conversation / Message / ReplyDraft には触らない。
 * 元メールとの対応(externalMessageId)も残るので、後から監査できる。
 *
 * 正しい取り込みは「今すぐ取り込む」を再実行すれば行われる。修正後は
 * 問い合わせページIDで会話をまとめるため、**新しい会話が作られる**。
 * 古い会話は孤児として残るので、削除するかどうかは人が判断する
 * (このスクリプトは削除しない。--report で一覧を出す)。
 *
 * ── 使い方 ──────────────────────────────────────────────────────
 *
 *   npm run repair:mercari-ingest              # 何もせず、対象を報告するだけ
 *   npm run repair:mercari-ingest -- --apply   # 通知を SUPERSEDED にする
 */
process.env.CONVERSATION_TABLE_NAME =
  process.env.CONVERSATION_TABLE_NAME || "Conversation-j6up24p7lnczdmklzjdt3vrp4y-NONE";

import { runWithDirectData, serverDataClient, inventoryAuthMode } from "@/lib/amplify/dataClient";
import { markDeliverySuperseded } from "@/lib/messaging/lineNotify/deliveryStore";

const APPLY = process.argv.includes("--apply");

interface ConvRow {
  id: string;
  channel?: string;
  externalCustomerId?: string;
  createdAt?: string;
}
interface DeliveryRow {
  id: string;
  conversationId?: string;
  status?: string;
  analysisStatus?: string;
  createdAt?: string;
  summaryText?: string;
}

/**
 * 誤って取り込まれた会話かどうか。
 *
 * 修正後の会話キーは `mercari-inquiry:<問い合わせID>`。それ以外の
 * `mercari-mail:` / `mercari-product:` は旧実装が作ったもので、
 * **問い合わせ通知ではないメールから作られている可能性が高い**。
 */
function isLegacyKey(key: string | undefined): boolean {
  if (!key) return false;
  return key.startsWith("mercari-mail:") || key.startsWith("mercari-product:");
}

async function main() {
  await runWithDirectData(async () => {
    const convs = (
      await serverDataClient.models.Conversation.list({ ...inventoryAuthMode, limit: 500 })
    ).data as unknown as ConvRow[];
    const mercari = convs.filter((c) => c.channel === "MERCARI_SHOPS");
    const legacy = mercari.filter((c) => isLegacyKey(c.externalCustomerId));
    const legacyIds = new Set(legacy.map((c) => c.id));

    const deliveries = (
      await serverDataClient.models.NotificationDelivery.list({ ...inventoryAuthMode, limit: 500 })
    ).data as unknown as DeliveryRow[];
    const targets = deliveries.filter(
      (d) => d.conversationId && legacyIds.has(d.conversationId) && d.status !== "SUPERSEDED",
    );

    console.log("=== メルカリ取り込みの修復 ===\n");
    console.log(`メルカリの会話          : ${mercari.length}件`);
    console.log(`旧キーの会話(修復対象)  : ${legacy.length}件`);
    console.log(`置き換える通知          : ${targets.length}件\n`);

    console.log("--- 旧キーの会話(削除はしない) ---");
    for (const c of legacy.slice(0, 30)) {
      console.log(`  ${c.createdAt ?? "-"}  ${c.externalCustomerId}`);
    }
    if (legacy.length > 30) console.log(`  … 他 ${legacy.length - 30}件`);

    if (!APPLY) {
      console.log("\n(--apply が無いため、何も変更していません)");
      console.log("通知を SUPERSEDED にするには: npm run repair:mercari-ingest -- --apply");
      return;
    }

    let done = 0;
    for (const d of targets) {
      await markDeliverySuperseded(
        d.id,
        null,
        "メール本文の抽出に失敗したまま作成された通知です。パーサ修正後の再取り込みで置き換えられました(内容は参考にしないでください)。",
      );
      done++;
    }
    console.log(`\n✓ ${done}件の通知を SUPERSEDED にしました。`);
    console.log("  Conversation / Message / ReplyDraft は変更していません(監査のため残しています)。");
    console.log("  正しい取り込みは「今すぐ取り込む」を実行してください。");
  });
}

main().catch((e) => {
  console.error("失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
});

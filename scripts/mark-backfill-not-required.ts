/**
 * 初回バックフィル・開発検証で作られた通知を「送信不要」にする。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────
 *
 * 通知先(友だち追加)が未登録の間に作られた通知は WAITING_FOR_TARGET の
 * まま溜まる。そのまま登録すると、**過去分が一斉にLINEへ飛ぶ**。
 * 今回溜まっているものは初回バックフィルと開発検証の履歴なので、
 * 実際に送る必要が無い。
 *
 * ── 消さない。1件だけ残す ───────────────────────────────────────
 *
 * 記録は NOT_REQUIRED として残す(何がなぜ送られなかったかを追えるように)。
 * 実機確認のために、**最新の正常な問い合わせ1件だけ**を
 * WAITING_FOR_TARGET のまま残す。
 *
 * 本物の新規問い合わせが一時的に送れなかった場合は WAITING_FOR_TARGET の
 * ままなので、再送の仕組みはそのまま使える。
 *
 * ── 使い方 ──────────────────────────────────────────────────────
 *
 *   npm run mark:backfill              # 判定して報告するだけ
 *   npm run mark:backfill -- --apply   # 実際に印を付ける
 */
process.env.CONVERSATION_TABLE_NAME =
  process.env.CONVERSATION_TABLE_NAME || "Conversation-j6up24p7lnczdmklzjdt3vrp4y-NONE";

import { runWithDirectData, serverDataClient, inventoryAuthMode } from "@/lib/amplify/dataClient";
import { markDeliveryNotRequired } from "@/lib/messaging/lineNotify/deliveryStore";

const APPLY = process.argv.includes("--apply");

interface Row {
  id: string;
  status?: string;
  analysisStatus?: string;
  inquiryKind?: string;
  createdAt?: string;
  sourceMessageId?: string;
  summaryText?: string;
  replyText?: string;
  conversationId?: string;
}

async function main() {
  await runWithDirectData(async () => {
    const all = (await serverDataClient.models.NotificationDelivery.list({ ...inventoryAuthMode, limit: 500 }))
      .data as unknown as Row[];

    // **メールの受信日時**で「最新」を決める。通知の createdAt は取り込みを
    // 走らせた時刻で、27件が数秒差で並ぶため「最新の問い合わせ」を表さない。
    const messages = (await serverDataClient.models.Message.list({ ...inventoryAuthMode, limit: 900 }))
      .data as unknown as { id: string; externalSentAt?: string }[];
    const sentAt = new Map(messages.map((m) => [m.id, m.externalSentAt ?? ""]));
    const receivedAt = (d: Row) => sentAt.get(String((d as { sourceMessageId?: string }).sourceMessageId ?? "")) ?? "";

    const waiting = all
      .filter((d) => d.status === "WAITING_FOR_TARGET" || d.status === "PENDING")
      .sort((a, b) => receivedAt(b).localeCompare(receivedAt(a)));

    console.log(`通知待ちの通知: ${waiting.length}件\n`);

    // 実機確認に使う1件を選ぶ。
    //
    // **2通とも中身がある、解析が正常に終わったものを選ぶ。** 要確認や
    // 生成失敗のものだと「正常系が通った」ことの確認にならない。
    const keep =
      waiting.find((d) => d.analysisStatus === "OK" && d.replyText && d.summaryText) ??
      waiting.find((d) => d.replyText && d.summaryText) ??
      waiting[0];

    if (!keep) {
      console.log("対象がありません。");
      return;
    }

    console.log("--- 実機確認用に残す1件 ---");
    console.log(`  メール受信: ${receivedAt(keep) || "不明"}  種別=${keep.inquiryKind ?? "-"}  解析=${keep.analysisStatus ?? "-"}`);
    console.log(`  1通目の先頭: ${String(keep.summaryText ?? "").split("\n")[0]}`);
    console.log(`  2通目あり  : ${Boolean(keep.replyText)}`);

    const targets = waiting.filter((d) => d.id !== keep.id);
    console.log(`\n--- 送信不要にする: ${targets.length}件 ---`);
    for (const d of targets.slice(0, 5)) {
      console.log(`  メール受信: ${receivedAt(d) || "不明"}  種別=${d.inquiryKind ?? "-"}  解析=${d.analysisStatus ?? "-"}`);
    }
    if (targets.length > 5) console.log(`  … 他 ${targets.length - 5}件`);

    if (!APPLY) {
      console.log("\n(--apply が無いため、何も変更していません)");
      return;
    }

    for (const d of targets) {
      await markDeliveryNotRequired(
        d.id,
        "初回バックフィル・開発検証で生成された履歴のため、送信対象から外しました(記録は保持しています)。",
      );
    }
    console.log(`\n✓ ${targets.length}件を NOT_REQUIRED にしました。`);
    console.log(`✓ 実機確認用の1件は WAITING_FOR_TARGET のまま残しています(id: ${keep.id})。`);
  });
}

main().catch((e) => {
  console.error("失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * 通知先が登録された後の実機確認(2026-09-03 利用者指示)。
 *
 *   targetUserId登録 → BELLO画面で「登録済み」→ テスト通知1通
 *   → 最新の実問い合わせ1件について2通通知
 *
 * ── 過去分を一括送信しない ──────────────────────────────────────
 *
 * 利用者の明示指示。resendWaitingDeliveries() は過去48時間・最大10件を
 * まとめて送るので**使わない**。retryDelivery() で
 * **最新の1件だけ**を指定して送る。残りは WAITING_FOR_TARGET のまま
 * 画面に残り、必要なものだけ個別に再送できる。
 *
 * Run with:
 *   AWS_PROFILE=Bello CONVERSATION_TABLE_NAME=Conversation-<suffix> \
 *     npm run send:line-notify-e2e
 */
import { runWithDirectData } from "@/lib/amplify/dataClient";
import { getLineNotifySettings } from "@/lib/messaging/lineNotify/settingsStore";
import { listRecentDeliveries } from "@/lib/messaging/lineNotify/deliveryStore";
import { retryDelivery, sendTestNotification } from "@/lib/messaging/lineNotify/service";

async function main() {
  await runWithDirectData(async () => {
    // ── 1. 通知先 ───────────────────────────────────────────────
    const settings = await getLineNotifySettings();
    console.log("── 通知先 ──");
    console.log(`  状態        : ${settings.targetUserId ? "登録済み" : "未登録"}`);
    console.log(`  表示名      : ${settings.targetDisplayName ?? "(取得できず)"}`);
    console.log(`  登録日時    : ${settings.followedAt ?? "—"}`);
    console.log(`  最終Webhook : ${settings.lastWebhookAt ?? "—"}`);
    console.log(`  受信内容    : ${settings.lastWebhookResult ?? "—"}`);
    if (!settings.targetUserId) {
      console.log("\n通知先が未登録のため送信しません。Botへメッセージを1通送ってください。");
      process.exit(1);
    }

    // ── 2. テスト通知(1通) ─────────────────────────────────────
    const test = await sendTestNotification();
    console.log(`\n── テスト通知 ──\n  ${test.ok ? "送信成功" : "送信失敗"}: ${test.message}`);

    // ── 3. 最新の実問い合わせ1件だけ(2通) ──────────────────────
    const all = await listRecentDeliveries(200);
    const waiting = all
      .filter((d) => d.status === "WAITING_FOR_TARGET" || d.status === "PENDING")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    console.log(`\n── 未送信の通知 ${waiting.length}件(送るのは最新1件だけ) ──`);
    for (const d of waiting) {
      console.log(`  ${d.createdAt}  ${d.status}  ${d.id}`);
    }
    const newest = waiting[0];
    if (!newest) {
      console.log("  未送信の通知がありません。");
      return;
    }

    console.log(`\n最新1件を送信します: ${newest.id} (${newest.createdAt})`);
    const r = await retryDelivery(newest.id);
    console.log(`  結果: ${r.sent ? "送信成功" : "送信失敗"} / 状態=${r.status}${r.reason ? ` / ${r.reason}` : ""}`);
    console.log(`\n残り${Math.max(0, waiting.length - 1)}件は未送信のまま残しています(一括送信しない指示のため)。`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

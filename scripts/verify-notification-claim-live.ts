/**
 * LINE通知の二重送信防止が、実際のDynamoDB上で効くことを確かめる
 * （2026-09-04 健全化 PHASE 9）。
 *
 *   AWS_PROFILE=Bello npm run verify:notification-claim-live
 *
 * ── なぜ実機で確かめる必要があるのか ────────────────────────────
 *
 * 通知の重複防止は「同じ dedupeKey では2件目を作れない」ことに乗っている。
 * これは**書き込みの条件（attribute_not_exists）がDBで効いているか**という
 * 一点で決まるので、モックでは何も証明できない。
 *
 * 実際、この経路には落とし穴があった。LINE Webhook / メール取込は
 * `runWithDirectData()` でAppSyncを迂回してDynamoDBへ直結する。その
 * 直結側の create が**無条件のPut**だったため、
 *
 *   ・2件目の作成が成功してしまい、重複防止が機能しない
 *   ・送信済み(SENT)の行を PENDING で上書きし、通知が復活する
 *
 * という状態だった。ここで確かめるのはまさにその2点。
 *
 * ── 後片付け ────────────────────────────────────────────────────
 *
 * 検証用の行は専用の dedupeKey（"__verify__" 接頭辞）で作り、最後に必ず
 * 削除する。実運用の通知には一切触れない。
 */
import { randomUUID } from "node:crypto";
import { ensureConversationTableName } from "./lib/resolveStagingTables";

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  await ensureConversationTableName();
  const { runWithDirectData, serverDataClient, inventoryAuthMode } = await import("@/lib/amplify/dataClient");
  const { claimPendingDelivery, markDeliverySent, findDeliveryByDedupeKey } = await import(
    "@/lib/messaging/lineNotify/deliveryStore"
  );

  // 実運用の通知と絶対に混ざらないキー。
  const dedupeKey = `__verify__:${randomUUID()}`;
  console.log(`[verify-notification-claim-live] dedupeKey=${dedupeKey}\n`);

  const base = {
    dedupeKey,
    conversationId: null,
    sourceMessageId: null,
    replyDraftId: null,
    channel: "LINE" as const,
    priority: "NORMAL" as const,
    summaryText: "検証用の行です（送信されません）。",
    replyText: null,
    createdBy: "verify-notification-claim-live",
  };

  try {
    await runWithDirectData(async () => {
      // 1回目 — 確保できる。
      const first = await claimPendingDelivery(base);
      check(first.claimed === true, "1回目のclaimは成功する", `status=${first.record.status}`);
      check(first.record.id === dedupeKey, "idがdedupeKeyそのものになる", first.record.id);

      // 2回目 — 同じキーなので負ける。ここが二重送信を止めている本体。
      const second = await claimPendingDelivery({ ...base, summaryText: "2回目（送られてはいけない）" });
      check(second.claimed === false, "2回目のclaimは負ける（＝2通目を送らない）");
      check(second.record.id === first.record.id, "負けた側は既存の行を受け取る", second.record.id);

      // 送信済みにしてから、もう一度claimしても**巻き戻らない**こと。
      await markDeliverySent(first.record.id);
      const third = await claimPendingDelivery({ ...base, summaryText: "3回目（復活してはいけない）" });
      check(third.claimed === false, "送信済みのあとのclaimも負ける");
      check(third.record.status === "SENT", "送信済みがPENDINGへ巻き戻らない", `status=${third.record.status}`);

      // 本文も上書きされていないこと（claim は既存行に触れない）。
      const reread = await findDeliveryByDedupeKey(dedupeKey);
      check(
        reread?.summaryText === base.summaryText,
        "負けたclaimは既存行の本文を書き換えない",
        `summaryText=${JSON.stringify(reread?.summaryText ?? null)}`,
      );
    });
  } finally {
    // 後片付けは成功・失敗にかかわらず必ず行う。
    await runWithDirectData(async () => {
      const { errors } = await serverDataClient.models.NotificationDelivery.delete({ id: dedupeKey }, inventoryAuthMode);
      if (errors) console.warn("[verify-notification-claim-live] 検証用の行を削除できませんでした", errors);
      else console.log("\n検証用の行を削除しました。");
    });
  }

  console.log(`\n合格 ${passes} / 失敗 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error(`[verify-notification-claim-live] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

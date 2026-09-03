/**
 * 2026-09-04 追加指示 §59/§67: 既存のメルカリShopsメールから
 * 「注文番号 → 商品」の対応をバックフィルする。
 *
 *   AWS_PROFILE=Bello npm run backfill:mercari-orders -- [--query "..."] [--limit 200] [--dry-run]
 *
 * ── 何をするか / 何をしないか ────────────────────────────────────
 *
 * するのは**対応表の補完だけ**。§59/§67 が明示的に禁じているとおり、
 *
 *   ・Conversation を増やさない
 *   ・Message を重複作成しない
 *   ・AI返信(ReplyDraft)を作らない
 *   ・社内LINE通知を再送しない
 *
 * このスクリプトは会話・メッセージ・通知のモジュールを**そもそも
 * import していない**。呼べないようにしておけば、うっかり呼ぶことも無い。
 *
 * ── 既定の検索条件 ──────────────────────────────────────────────
 *
 * 定期取り込みの条件は `newer_than:7d` で、過去の購入通知には届かない。
 * ここでは期間を切らずに送信元だけで絞る(誤検出はパーサ側が定型文で弾く)。
 */
import { ensureConversationTableName } from "./lib/resolveStagingTables";

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const dryRun = args.includes("--dry-run");
  const query = flag("--query") ?? "from:no-reply@mercari-shops.com";
  const limit = Number(flag("--limit") ?? "300");

  const table = await ensureConversationTableName();
  console.log(`[backfill-mercari-orders] 開始 ${new Date().toISOString()}`);
  console.log(`  Conversationテーブル: ${table}`);
  console.log(`  検索条件            : ${query}`);
  console.log(`  上限                : ${limit}件${dryRun ? "  (--dry-run: 保存しません)" : ""}`);

  // テーブル名を環境変数へ入れてから読み込む。lib側はモジュール読み込み時に
  // 環境変数を見るものがあるので、順序を守る。
  const { fetchMercariNotificationMailsByIds, listMercariMailIdsByQuery } = await import(
    "@/lib/messaging/email/gmailClient"
  );
  const { parseMercariNotificationMail, canonicalOrderId } = await import(
    "@/lib/messaging/mercari/notificationMailParser"
  );
  const { recordOrderContextFromMail } = await import("@/lib/messaging/mercari/orderProductContext");
  const { getMercariOrderContext } = await import("@/lib/messaging/mercari/orderContextStore");

  const ids = await listMercariMailIdsByQuery(query, limit);
  console.log(`  対象メール          : ${ids.length}件`);

  const stats = {
    purchaseNotifications: 0,
    orderMessages: 0,
    others: 0,
    withOrderId: 0,
    recorded: 0,
    resolvedInventory: 0,
    alreadyComplete: 0,
    failed: 0,
  };
  const orders = new Map<string, { productName: string | null; inventory: string | null; source: string }>();

  // 1通ずつ本文を取る(Gmail APIの都合)。20通ずつに区切って進捗を出す。
  const CHUNK = 20;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const mails = await fetchMercariNotificationMailsByIds(ids.slice(i, i + CHUNK));
    for (const mail of mails) {
      try {
        const parsed = parseMercariNotificationMail(mail);
        if (parsed.kind === "PURCHASE_NOTIFICATION") stats.purchaseNotifications++;
        else if (parsed.kind === "ORDER_MESSAGE") stats.orderMessages++;
        else stats.others++;

        const orderId = canonicalOrderId(parsed.order.orderNumber);
        if (!orderId) continue;
        stats.withOrderId++;

        const before = await getMercariOrderContext(orderId);
        // 既に商品名も在庫も確定しているなら、在庫の再照合まではやらない
        // (全在庫スキャンが1件ごとに走ると時間がかかる)。
        const complete = Boolean(before?.productName) && before?.inventoryStatus === "RESOLVED";
        if (complete && before) {
          stats.alreadyComplete++;
          orders.set(orderId, {
            productName: before.productName,
            inventory: before.displayInventoryId,
            source: before.evidenceSource ?? "-",
          });
          continue;
        }

        if (dryRun) {
          orders.set(orderId, {
            productName: parsed.productName ?? before?.productName ?? null,
            inventory: before?.displayInventoryId ?? null,
            source: `${parsed.kind}(dry-run)`,
          });
          continue;
        }

        const saved = await recordOrderContextFromMail({
          parsed,
          gmailId: mail.gmailId,
          receivedAt: mail.receivedAt,
          who: "backfill-mercari-orders",
        });
        if (!saved) {
          stats.failed++;
          continue;
        }
        stats.recorded++;
        if (saved.inventoryStatus === "RESOLVED") stats.resolvedInventory++;
        orders.set(orderId, {
          productName: saved.productName,
          inventory: saved.displayInventoryId,
          source: saved.evidenceSource ?? "-",
        });
      } catch (err) {
        stats.failed++;
        console.error(`  ! ${mail.gmailId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`  ...${Math.min(i + CHUNK, ids.length)}/${ids.length}`);
  }

  console.log("");
  console.log("── 結果 ─────────────────────────────────────────────");
  console.log(`  購入通知            : ${stats.purchaseNotifications}件`);
  console.log(`  取引メッセージ      : ${stats.orderMessages}件`);
  console.log(`  対象外              : ${stats.others}件`);
  console.log(`  注文番号あり        : ${stats.withOrderId}件`);
  console.log(`  対応表へ登録        : ${stats.recorded}件`);
  console.log(`  うち在庫まで特定    : ${stats.resolvedInventory}件`);
  console.log(`  既に確定済み        : ${stats.alreadyComplete}件`);
  console.log(`  失敗                : ${stats.failed}件`);
  console.log(`  注文の実数          : ${orders.size}件`);
  console.log("");
  for (const [orderId, v] of orders) {
    console.log(`  ${orderId}  在庫=${v.inventory ?? "-"}  出所=${v.source}  ${v.productName ?? "(商品名なし)"}`);
  }
  console.log(`[backfill-mercari-orders] 完了`);
}

void main().catch((err) => {
  console.error(`[backfill-mercari-orders] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

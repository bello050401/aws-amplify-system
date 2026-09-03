/**
 * 通知BotのWebhookを実機で確かめる。
 *
 * ── 何を確かめるか ──────────────────────────────────────────────
 *
 * 「LINEからのPOSTは200で返っているのに通知先が登録されない」という状態を
 * 実際に踏んだ。routeは何が起きても200を返し(500だとLINEが再送し続ける)、
 * SSRのconsoleログもCloudWatchへ届かない(d44d8e0)ため、
 * **届いていないのか、届いた後に失敗したのかを判別できなかった**。
 *
 * そこで e17dde4 で受信結果をDBへ残すようにした。この検証はそれが実機で
 * 効いていることを、**通知先を壊さずに**確かめる:
 *
 *   1. Secrets Manager の Channel Secret で正しい署名を作る
 *   2. LINEのWebhook検証と同じダミーIDのイベントを送る
 *   3. 200が返ること / 受信結果がDBへ残ること / **通知先が変わらないこと**
 *
 * ダミーIDを使うのは意図的。実在しないIDが通知先として登録されると、
 * 送信APIはエラーを返さないまま誰にも届かなくなる —— 一番気づきにくい
 * 壊れ方なので、そこを塞げているかを本番で確かめる価値がある。
 *
 * 署名が正しくないと401で弾かれるため、この検証は署名検証が生きている
 * ことの確認も兼ねる。
 *
 * Run with:
 *   AWS_PROFILE=Bello CONVERSATION_TABLE_NAME=Conversation-<suffix> \
 *     npm run verify:notify-webhook-live
 */
import { createHmac } from "node:crypto";
import { runWithDirectData } from "@/lib/amplify/dataClient";
import { getNotifyBotChannelSecret } from "@/lib/messaging/lineNotify/secretStore";
import { getLineNotifySettings } from "@/lib/messaging/lineNotify/settingsStore";
import { LINE_WEBHOOK_TEST_USER_ID } from "@/lib/messaging/lineNotify/registrationPolicy";

const BASE_URL =
  process.env.NOTIFY_WEBHOOK_BASE_URL ??
  "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const secret = await getNotifyBotChannelSecret();
  if (!secret) throw new Error("通知BotのChannel Secretを読めませんでした。");

  const before = await runWithDirectData(() => getLineNotifySettings());
  console.log(`送信前の通知先: ${before.targetUserId ? "登録済み" : "未登録"}`);

  const payload = JSON.stringify({
    destination: "xxxxxxxxxx",
    events: [
      {
        type: "message",
        mode: "active",
        timestamp: Date.now(),
        source: { type: "user", userId: LINE_WEBHOOK_TEST_USER_ID },
        webhookEventId: "01FZ74A0TDDPYRVKNK77XKC3ZR",
        deliveryContext: { isRedelivery: false },
        message: { id: "14353798921116", type: "text", text: "Hello, world" },
      },
    ],
  });
  const signature = createHmac("sha256", secret).update(payload).digest("base64");

  const url = `${BASE_URL}/api/line/notify-webhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body: payload,
  });
  check(res.status === 200, "正しい署名のリクエストは200で受理される", `status=${res.status}`);

  // 署名が違えば弾かれること。ここが素通りすると、誰でも通知先を
  // 書き換えられる状態になる。
  const bad = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": "invalid" },
    body: payload,
  });
  check(bad.status === 401, "署名が不正なリクエストは401で弾かれる", `status=${bad.status}`);

  const after = await runWithDirectData(() => getLineNotifySettings());
  check(
    after.targetUserId === before.targetUserId,
    "検証用イベントで通知先が書き換わらない",
    `${before.targetUserId ? "登録済み" : "未登録"} → ${after.targetUserId ? "登録済み" : "未登録"}`,
  );
  check(
    after.targetUserId !== LINE_WEBHOOK_TEST_USER_ID,
    "ダミーIDが通知先になっていない",
  );
  check(Boolean(after.lastWebhookAt), "受信日時が記録されている", after.lastWebhookAt ?? "(無し)");
  check(
    (after.lastWebhookResult ?? "").includes("通知先は変更していません"),
    "受信結果に検証を受け取った旨が残っている",
    after.lastWebhookResult ?? "(無し)",
  );

  console.log(`\n${failures === 0 ? "すべて成功" : `${failures}件失敗`}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

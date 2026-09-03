/**
 * 社内LINE通知の**実機**検証。
 *
 * ── 何を確かめるか ──────────────────────────────────────────────
 *
 * 純粋関数の検証(scripts/verify-line-notify.ts)は文面と判定を固定するが、
 * 「実際にLINEへ届くか」「デプロイ済みの経路が通るか」は確かめられない。
 * このスクリプトは**デプロイ済みのアプリへ、署名付きの本物のWebhookを
 * 送る**ことで、本番と同じ経路を通す:
 *
 *   署名検証 → メッセージ保存 → 商品特定 → AI返信案 → 社内LINEへ2通
 *
 * lib/inquiry/autoReply.ts は serverDataClient(Cookie前提)を使うため、
 * ローカルのスクリプトからは呼べない。Webhookを叩くのが唯一、本番と
 * 同じ経路を通す方法。
 *
 * ── 安全策 ──────────────────────────────────────────────────────
 *
 *  - 送信先は Staging のみ(URLを引数で受け取らず、既定を固定)
 *  - テスト用の顧客IDは "Utest" で始まる固定値。実顧客と混ざらない
 *  - `cleanup` で作ったデータを消せる
 *  - 実行にはサブコマンドが必須。引数無しでは何も送らない
 *
 * ── 使い方 ──────────────────────────────────────────────────────
 *
 *   npm run verify:line-notify-live status                 状態を見るだけ
 *   npm run verify:line-notify-live test-send              §35 テスト送信
 *   npm run verify:line-notify-live inquiry negotiation    問い合わせを1件流す
 *   npm run verify:line-notify-live inquiry no-dest        配送先なしの値下げ
 *   npm run verify:line-notify-live inquiry simple         通常の質問
 *   npm run verify:line-notify-live duplicate              同じmessageIdを2回送る
 *   npm run verify:line-notify-live cleanup                テストデータを消す
 */
import { createHmac } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const APP_URL = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
const API = "j6up24p7lnczdmklzjdt3vrp4y";
const T = (m: string) => `${m}-${API}-NONE`;
const REGION = "us-west-2";

/** テスト用の顧客ID。実顧客と混ざらないよう "Utest" 固定にする。 */
const TEST_USER_ID = "Utest0000000000000000000000000001";
/** 実在するBASE商品(在庫と紐づくことを確認済み)。 */
const TEST_PRODUCT_URL = "https://bellointeri.base.shop/items/153913832";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sm = new SecretsManagerClient({ region: REGION });

async function readSecret(id: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: id }));
    return res.SecretString ? (JSON.parse(res.SecretString) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function scanAll(table: string) {
  const out: any[] = [];
  let key: any;
  do {
    const r: any = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return out;
}

const SCENARIOS: Record<string, { label: string; text: string }> = {
  negotiation: {
    label: "値下げ交渉 + 配送先あり(§40 Case A)",
    text: `こんにちは。この商品について伺いたいです。\n${TEST_PRODUCT_URL}\n埼玉県なのですが、お値下げ可能でしょうか。`,
  },
  "no-dest": {
    label: "値下げ交渉 + 配送先なし(§40 Case B)",
    text: `${TEST_PRODUCT_URL}\nお値下げ可能ですか？`,
  },
  simple: {
    label: "通常の質問(要確認が付かないこと)",
    text: `${TEST_PRODUCT_URL}\nサイズを教えていただけますか。`,
  },
  unknown: {
    label: "商品が特定できない問い合わせ(§40 Case D)",
    text: "先日見た椅子について教えてください。",
  },
};

/** 署名付きでWebhookを叩く。本番と同じ経路。 */
async function postWebhook(messageId: string, text: string): Promise<{ status: number; body: string }> {
  const secret = await readSecret("bello/line-channel-secret");
  const channelSecret = typeof secret?.channelSecret === "string" ? secret.channelSecret : null;
  if (!channelSecret) throw new Error("顧客向けLINEのChannel Secretが読めません(署名を作れません)。");

  const body = JSON.stringify({
    destination: "Utest",
    events: [
      {
        type: "message",
        mode: "active",
        timestamp: Date.now(),
        source: { type: "user", userId: TEST_USER_ID },
        webhookEventId: `test-${messageId}`,
        deliveryContext: { isRedelivery: false },
        message: { type: "text", id: messageId, text },
      },
    ],
  });
  const signature = createHmac("sha256", channelSecret).update(body, "utf8").digest("base64");

  const res = await fetch(`${APP_URL}/api/line/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": signature },
    body,
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}

/**
 * 通知Bot側のWebhookへ、署名付きの follow / unfollow を送る。
 *
 * **顧客向けチャネルとは別のChannel Secretで署名する** —— 通知Botは
 * 別チャネルなので、こちらの秘密を使わないと署名検証を通らない。
 */
async function postNotifyWebhook(eventType: "follow" | "unfollow", userId: string): Promise<{ status: number }> {
  const secret = await readSecret("bello/line-notify-bot");
  const channelSecret = typeof secret?.channelSecret === "string" ? secret.channelSecret : null;
  if (!channelSecret) throw new Error("通知BotのChannel Secretが読めません(まだ登録されていません)。");

  const body = JSON.stringify({
    destination: "Ubot",
    events: [
      {
        type: eventType,
        mode: "active",
        timestamp: Date.now(),
        source: { type: "user", userId },
        webhookEventId: `test-${eventType}-${Date.now()}`,
        deliveryContext: { isRedelivery: false },
      },
    ],
  });
  const signature = createHmac("sha256", channelSecret).update(body, "utf8").digest("base64");
  const res = await fetch(`${APP_URL}/api/line/notify-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": signature },
    body,
  });
  return { status: res.status };
}

async function targetUserId(): Promise<string | null> {
  const rows = await scanAll(T("LineNotifySettings"));
  return (rows[0]?.targetUserId as string) ?? null;
}

/**
 * follow イベントで通知先が自動登録されるかを確かめる。
 *
 * **テスト用の偽IDで登録したまま終わらせない。** 偽の宛先が残ると、実際の
 * 問い合わせ通知が届かない相手へ送られ続ける。確認できたら unfollow を送って
 * 元の状態(未登録、または既に登録済みの本物)へ必ず戻す。
 */
async function verifyFollow() {
  const before = await targetUserId();
  console.log(`実行前の通知先: ${before ?? "未登録"}`);
  if (before && !before.startsWith("Utest")) {
    console.log("既に本物の通知先が登録されています。上書きしないため、この確認は行いません。");
    return;
  }

  const fake = "Utest0000000000000000000000000009";
  const f = await postNotifyWebhook("follow", fake);
  console.log(`follow 送信: HTTP ${f.status}`);
  const afterFollow = await targetUserId();
  console.log(`  → 通知先: ${afterFollow ?? "未登録"}`);
  if (afterFollow === fake) console.log("  ✓ follow イベントから通知先が自動登録された");
  else console.log("  ✗ 自動登録されなかった");

  const u = await postNotifyWebhook("unfollow", fake);
  console.log(`unfollow 送信: HTTP ${u.status}`);
  const afterUnfollow = await targetUserId();
  console.log(`  → 通知先: ${afterUnfollow ?? "未登録"}`);
  if (!afterUnfollow) console.log("  ✓ unfollow で通知先が外れた(偽IDを残さない)");
  else console.log("  ✗ 偽の通知先が残っている。手動で消してください。");
}

async function showStatus() {
  const notify = await readSecret("bello/line-notify-bot");
  console.log("=== 社内通知Bot ===");
  console.log(`  Secret         : ${notify ? (notify.configured ? "設定済み" : "未設定") : "未作成"}`);
  console.log(`  channelSecret  : ${notify?.channelSecret ? "あり" : "なし"}`);
  console.log(`  accessToken    : ${notify?.accessToken ? "あり" : "なし"}`);

  const settings = await scanAll(T("LineNotifySettings"));
  const s = settings[0];
  console.log("\n=== 通知先 ===");
  console.log(`  targetUserId   : ${s?.targetUserId ? "登録済み" : "未登録(友だち追加が必要)"}`);
  console.log(`  表示名         : ${s?.targetDisplayName ?? "-"}`);
  console.log(`  Bot名          : ${s?.botDisplayName ?? "-"}`);
  console.log(`  最終通知       : ${s?.lastNotifiedAt ?? "-"} (${s?.lastNotifyStatus ?? "-"})`);

  const deliveries = (await scanAll(T("NotificationDelivery"))).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  console.log(`\n=== 通知履歴(直近5件 / 全${deliveries.length}件) ===`);
  for (const d of deliveries.slice(0, 5)) {
    console.log(`  ${d.createdAt}  ${String(d.status).padEnd(11)} ${d.priority ?? "-"}  試行${d.attemptCount ?? 0}  ${d.dedupeKey}`);
    if (d.errorMessage) console.log(`      ${d.errorMessage}`);
  }
}

async function testConversationIds(): Promise<Set<string>> {
  const convs = (await scanAll(T("Conversation"))).filter((c) => c.externalCustomerId === TEST_USER_ID);
  return new Set(convs.map((c) => c.id as string));
}

async function waitAndReport(_unused: string, label: string) {
  // Webhookは同期処理なので、応答が返った時点で通知まで終わっている。
  //
  // dedupeKey は "LINE:<会話ID>:<Messageの行ID>" で、**LINEのmessage.idでは
  // ない**。テスト用のmessageIdで絞ると必ず0件になり、「通知が作られていない」
  // と誤って読める(実際に一度そう誤診した)。会話IDで絞る。
  const convIds = await testConversationIds();
  const deliveries = (await scanAll(T("NotificationDelivery")))
    .filter((d) => convIds.has(String(d.conversationId)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  console.log(`\n--- ${label} の通知レコード (${deliveries.length}件) ---`);
  for (const d of deliveries) {
    console.log(`  status=${d.status} priority=${d.priority ?? "-"} 試行=${d.attemptCount ?? 0}`);
    if (d.errorMessage) console.log(`  error: ${d.errorMessage}`);
    if (d.summaryText) {
      console.log("\n  [1通目]");
      console.log(
        String(d.summaryText)
          .split("\n")
          .map((l: string) => "    " + l)
          .join("\n"),
      );
    }
    if (d.replyText) {
      console.log("\n  [2通目]");
      console.log(
        String(d.replyText)
          .split("\n")
          .map((l: string) => "    " + l)
          .join("\n"),
      );
    }
  }
  return deliveries;
}

async function cleanup() {
  let removed = 0;

  const convs = (await scanAll(T("Conversation"))).filter((c) => c.externalCustomerId === TEST_USER_ID);
  const convIds = new Set(convs.map((c) => c.id));

  const msgs = (await scanAll(T("Message"))).filter((m) => convIds.has(m.conversationId));
  for (const m of msgs) {
    await ddb.send(new DeleteCommand({ TableName: T("Message"), Key: { id: m.id } }));
    removed++;
  }
  const drafts = (await scanAll(T("ReplyDraft"))).filter((d) => convIds.has(d.conversationId));
  for (const d of drafts) {
    await ddb.send(new DeleteCommand({ TableName: T("ReplyDraft"), Key: { id: d.id } }));
    removed++;
  }
  const dels = (await scanAll(T("NotificationDelivery"))).filter((d) => convIds.has(d.conversationId));
  for (const d of dels) {
    await ddb.send(new DeleteCommand({ TableName: T("NotificationDelivery"), Key: { id: d.id } }));
    removed++;
  }
  for (const c of convs) {
    await ddb.send(new DeleteCommand({ TableName: T("Conversation"), Key: { id: c.id } }));
    removed++;
  }
  console.log(`テストデータを${removed}件削除しました(会話${convs.length}件、メッセージ${msgs.length}件、返信案${drafts.length}件、通知${dels.length}件)。`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || cmd === "status") {
    await showStatus();
    return;
  }

  if (cmd === "cleanup") {
    await cleanup();
    return;
  }

  if (cmd === "follow-test") {
    await verifyFollow();
    return;
  }

  if (cmd === "test-send") {
    console.log("§35 テスト送信は管理画面の「テスト通知を送信」ボタンから実行してください。");
    console.log("(Server Action経由でADMIN/EDITOR権限を確認する設計のため、スクリプトからは呼べません)");
    return;
  }

  if (cmd === "inquiry") {
    const key = arg ?? "negotiation";
    const scenario = SCENARIOS[key];
    if (!scenario) {
      console.error(`不明なシナリオ: ${key}  (${Object.keys(SCENARIOS).join(" / ")})`);
      process.exit(1);
    }
    const messageId = `testmsg-${Date.now()}`;
    console.log(`シナリオ: ${scenario.label}`);
    console.log(`messageId: ${messageId}\n本文:\n${scenario.text}\n`);

    // Webhookは同期処理なので、応答までの時間がそのまま
    // 「受信→保存→商品特定→AI生成→通知」の所要時間になる。
    // Amplify Hostingの実行時間上限に対する余裕を測るために出す(§7)。
    const startedAt = Date.now();
    const res = await postWebhook(messageId, scenario.text);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Webhook応答: HTTP ${res.status} ${res.body}  (${elapsed}秒)`);
    if (res.status !== 200) {
      console.error("Webhookが200を返しませんでした。処理が完了していない可能性があります。");
    }

    // 保存・解析まで到達したかを、通知とは別に数える。
    const convs = (await scanAll(T("Conversation"))).filter((c) => c.externalCustomerId === TEST_USER_ID);
    const convIds = new Set(convs.map((c) => c.id));
    const msgs = (await scanAll(T("Message"))).filter((m) => convIds.has(m.conversationId));
    const drafts = (await scanAll(T("ReplyDraft"))).filter((d) => convIds.has(d.conversationId));
    console.log(`\nConversation ${convs.length}件 / Message ${msgs.length}件 / ReplyDraft ${drafts.length}件`);
    const draft = drafts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (draft) {
      const ev = typeof draft.sourceSummary === "string" ? JSON.parse(draft.sourceSummary) : draft.sourceSummary;
      console.log(`  返信案の状態 : ${draft.status}`);
      console.log(`  商品特定     : ${ev?.productStatus ?? "-"} ${ev?.product?.name ? `(${String(ev.product.name).slice(0, 30)})` : ""}`);
      console.log(`  分類         : ${(typeof draft.intents === "string" ? JSON.parse(draft.intents) : draft.intents ?? []).join(", ") || "-"}`);
      console.log(`  適用ルール   : ${(ev?.appliedReplyRules ?? []).map((r: { title: string }) => r.title).join(" / ") || "なし"}`);
      console.log(`  参照ナレッジ : ${(ev?.knowledgeDocuments ?? []).map((k: { title: string }) => k.title).join(" / ") || "なし"}`);
      console.log(`  モデル       : ${draft.modelName ?? "-"}`);
    }

    await waitAndReport(messageId, scenario.label);
    return;
  }

  if (cmd === "duplicate") {
    const messageId = `testmsg-dup-${Date.now()}`;
    const scenario = SCENARIOS.negotiation;
    console.log(`重複防止の確認: 同じ messageId (${messageId}) を2回送る\n`);

    const first = await postWebhook(messageId, scenario.text);
    console.log(`1回目: HTTP ${first.status}`);
    const afterFirst = await waitAndReport(messageId, "1回目");

    const second = await postWebhook(messageId, scenario.text);
    console.log(`\n2回目: HTTP ${second.status}`);
    const convIds2 = await testConversationIds();
    const afterSecond = (await scanAll(T("NotificationDelivery"))).filter((d) => convIds2.has(String(d.conversationId)));

    console.log(`\n通知レコード: 1回目=${afterFirst.length}件 → 2回目=${afterSecond.length}件`);
    if (afterSecond.length === afterFirst.length && afterFirst.length === 1) {
      console.log("✓ 重複防止が効いている(通知レコードが増えていない = LINEへ2通目は飛んでいない)");
    } else {
      console.log("✗ 重複防止が効いていない可能性がある");
    }
    return;
  }

  console.error(`不明なコマンド: ${cmd}`);
  console.error("status / test-send / inquiry <scenario> / duplicate / cleanup");
  process.exit(1);
}

void main().catch((e) => {
  console.error("失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
});

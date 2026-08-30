/**
 * BELLO統合業務OS指示書(2026-08-30) §51/§87: LINE連携の純粋ロジック
 * (lib/messaging/line/signature.ts, lib/messaging/line/adapter.tsの
 * parseLineWebhookBody)のstandalone verification。
 *
 * Run with: npm run verify:line
 */
import { createHmac } from "node:crypto";
import { verifyLineSignature } from "@/lib/messaging/line/signature";
import { parseLineWebhookBody } from "@/lib/messaging/line/adapter";
import type { LineWebhookBody } from "@/lib/messaging/line/types";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

function testVerifyLineSignature() {
  const secret = "test-channel-secret";
  const body = '{"destination":"xxxxxxxxxx","events":[]}';
  const correctSignature = createHmac("sha256", secret).update(body, "utf8").digest("base64");

  assertTrue(verifyLineSignature(body, correctSignature, secret), "verifyLineSignature: 正しい署名は検証を通る(公式ドキュメント通りのHMAC-SHA256+base64)");
  assertTrue(!verifyLineSignature(body, "invalid-signature", secret), "verifyLineSignature: 不正な署名は拒否される");
  assertTrue(!verifyLineSignature(body, correctSignature, "wrong-secret"), "verifyLineSignature: 違うChannel Secretで計算すると不一致になる");
  assertTrue(!verifyLineSignature(body, null, secret), "verifyLineSignature: 署名ヘッダが無ければ拒否される");
  assertTrue(!verifyLineSignature(body + "tampered", correctSignature, secret), "verifyLineSignature: ボディが改ざんされていれば拒否される(タイムセーフ比較の前に長さ不一致で弾く経路も含む)");

  const emptySignature = createHmac("sha256", secret).update("", "utf8").digest("base64");
  assertTrue(verifyLineSignature("", emptySignature, secret), "verifyLineSignature: 空ボディでも正しく検証できる(境界値)");
}

function testParseLineWebhookBody() {
  const body: LineWebhookBody = {
    destination: "xxxxxxxxxx",
    events: [
      {
        type: "message",
        webhookEventId: "evt1",
        timestamp: 1735689600000,
        source: { type: "user", userId: "U1234567890" },
        replyToken: "reply-token-1",
        message: { id: "msg1", type: "text", text: "こんにちは" },
      },
      // followイベント(メッセージではない) — 無視されるべき
      { type: "follow", webhookEventId: "evt2", timestamp: 1735689601000, source: { type: "user", userId: "U1234567890" } },
      // 画像メッセージ — 現状textのみ扱うので無視されるべき
      {
        type: "message",
        webhookEventId: "evt3",
        timestamp: 1735689602000,
        source: { type: "user", userId: "U1234567890" },
        message: { id: "msg3", type: "image" },
      },
      // グループでの発言(userId無し) — 1:1チャット前提のため無視されるべき
      {
        type: "message",
        webhookEventId: "evt4",
        timestamp: 1735689603000,
        source: { type: "group", groupId: "G1" },
        message: { id: "msg4", type: "text", text: "グループでの発言" },
      },
    ],
  };

  const normalized = parseLineWebhookBody(body);
  assertEqual(normalized.length, 1, "parseLineWebhookBody: 4イベント中、1:1チャットのテキストメッセージ1件だけが正規化される");
  assertEqual(normalized[0].externalMessageId, "msg1", "parseLineWebhookBody: externalMessageIdはmessage.id");
  assertEqual(normalized[0].externalCustomerId, "U1234567890", "parseLineWebhookBody: externalCustomerIdはsource.userId");
  assertEqual(normalized[0].body, "こんにちは", "parseLineWebhookBody: bodyはmessage.text");
  assertEqual(normalized[0].replyToken, "reply-token-1", "parseLineWebhookBody: replyTokenも保持する");
  assertEqual(normalized[0].externalSentAt, new Date(1735689600000).toISOString(), "parseLineWebhookBody: externalSentAtはtimestampのISO文字列化");

  assertEqual(parseLineWebhookBody({ destination: "x", events: [] }), [], "parseLineWebhookBody: イベントが無ければ空配列");
}

function main() {
  testVerifyLineSignature();
  testParseLineWebhookBody();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();

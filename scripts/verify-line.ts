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

// ── 自動QA: LINE webhook が取りこぼしを隠していた問題 ────────────────
// 以前は recordIncomingMessage が失敗しても常に 200 `{ok:true}` を返して
// いた。LINEは2xxを受信成功とみなして**再送しない**ため、記録に失敗した
// メッセージはそのまま失われていた——当時のコメントが前提にしていた
// 「失敗してもLINEの再送で安全に再処理できる」は、200を返している限り
// 成立しない。
//
// 修正後は1件でも失敗したら500を返して再送させる。再送で重複しないことは
// recordIncomingMessageのidempotency(externalMessageIdのGSIで既存を検出)
// が保証する。ここではその「再送しても安全」という前提そのものを固定する。
function testLineWebhookRetryContract() {
  // 同一 externalMessageId が2回届いても、2回目は重複として扱われる
  // (=500を返して全件再送させても、成功済みは二重登録されない)という
  // 契約を、parse段階のIDの一意性で確認する。
  const body: LineWebhookBody = {
    destination: "U0000000000000000000000000000000",
    events: [
      {
        type: "message",
        replyToken: "r1",
        timestamp: 1756500000000,
        source: { type: "user", userId: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        message: { id: "msg-1", type: "text", text: "1件目" },
      },
      {
        type: "message",
        replyToken: "r2",
        timestamp: 1756500001000,
        source: { type: "user", userId: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        message: { id: "msg-2", type: "text", text: "2件目" },
      },
    ],
  } as LineWebhookBody;

  const parsed = parseLineWebhookBody(body);
  assertEqual(parsed.length, 2, "parseLineWebhookBody: 2件のイベントを2件として取り出す");
  const ids = parsed.map((m) => m.externalMessageId);
  assertEqual(new Set(ids).size, 2, "parseLineWebhookBody: externalMessageIdが一意(再送時の重複判定キーとして使える)");
  assertTrue(
    ids.every((id) => typeof id === "string" && id.length > 0),
    "parseLineWebhookBody: externalMessageIdが必ず埋まる(空だとidempotency判定が効かず、再送で重複登録される)",
  );

  // 同じbodyをもう一度parseしても同じIDになる — LINEの再送は同一IDで届く
  const reparsed = parseLineWebhookBody(body);
  assertEqual(
    reparsed.map((m) => m.externalMessageId),
    ids,
    "parseLineWebhookBody: 同じイベントを再parseすると同じexternalMessageIdになる(再送が重複と判定できる根拠)",
  );
}

function main() {
  testVerifyLineSignature();
  testParseLineWebhookBody();
  testLineWebhookRetryContract();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();

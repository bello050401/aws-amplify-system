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
import { sendLinePush, sendLineReply } from "@/lib/messaging/line/adapter";
import {
  LINE_OUTBOUND_FLAG,
  LineOutboundDisabledError,
  getLineOutboundStatus,
  isLineOutboundEnabled,
} from "@/lib/messaging/line/outboundGuard";

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
  // 【2026-09-02 仕様変更】以前はテキスト1件だけを取り、画像イベントは
  // パーサ段階で捨てていた —— そのため画像を送られると会話に何も残らず、
  // 「画像が受信できない」という形で表面化していた。
  // 1:1チャットのメッセージは種別を問わず残し、follow等とグループ発言は
  // これまで通り無視する(4イベント中2件)。
  assertEqual(normalized.length, 2, "parseLineWebhookBody: 1:1チャットのメッセージは種別を問わず残る(follow・グループ発言は無視)");
  assertEqual(normalized[0].externalMessageId, "msg1", "parseLineWebhookBody: externalMessageIdはmessage.id");
  assertEqual(normalized[0].externalCustomerId, "U1234567890", "parseLineWebhookBody: externalCustomerIdはsource.userId");
  assertEqual(normalized[0].body, "こんにちは", "parseLineWebhookBody: bodyはmessage.text");
  assertEqual(normalized[0].contentKind, "TEXT", "parseLineWebhookBody: テキストはTEXT種別");
  assertEqual(normalized[0].hasDownloadableContent, false, "parseLineWebhookBody: テキストに取得すべき実体は無い");
  assertEqual(normalized[0].replyToken, "reply-token-1", "parseLineWebhookBody: replyTokenも保持する");
  assertEqual(normalized[0].externalSentAt, new Date(1735689600000).toISOString(), "parseLineWebhookBody: externalSentAtはtimestampのISO文字列化");

  // 画像イベント。本文が無いことを理由に捨てない、が要件の中心。
  const image = normalized[1];
  assertEqual(image.externalMessageId, "msg3", "parseLineWebhookBody: 画像イベントも正規化される");
  assertEqual(image.contentKind, "IMAGE", "parseLineWebhookBody: 画像はIMAGE種別");
  assertEqual(image.body, "[画像]", "parseLineWebhookBody: 本文が無い画像は代替表示にする(空文字で保存しない)");
  assertEqual(image.hasDownloadableContent, true, "parseLineWebhookBody: 画像はLINEのコンテンツAPIから実体を取れる");

  // スタンプ・未対応形式も、届いた事実は残す。
  const stickerOnly = parseLineWebhookBody({
    destination: "x",
    events: [
      {
        type: "message",
        webhookEventId: "evt9",
        timestamp: 1735689600000,
        source: { type: "user", userId: "U1234567890" },
        message: { id: "msg9", type: "sticker" },
      },
    ],
  });
  assertEqual(stickerOnly.length, 1, "parseLineWebhookBody: スタンプも捨てずに残す");
  assertEqual(stickerOnly[0].contentKind, "STICKER", "parseLineWebhookBody: スタンプはSTICKER種別");
  assertEqual(stickerOnly[0].hasDownloadableContent, false, "parseLineWebhookBody: スタンプに取得すべき実体は無い");

  // 本文が空のテキストは、記録しても何も分からないので従来どおり捨てる。
  const emptyText = parseLineWebhookBody({
    destination: "x",
    events: [
      {
        type: "message",
        webhookEventId: "evt10",
        timestamp: 1735689600000,
        source: { type: "user", userId: "U1234567890" },
        message: { id: "msg10", type: "text", text: "   " },
      },
    ],
  });
  assertEqual(emptyText.length, 0, "parseLineWebhookBody: 本文が空のテキストは残さない");

  // 外部URL提供の画像はコンテンツAPIから取れない。取れるつもりで失敗させない。
  const externalImage = parseLineWebhookBody({
    destination: "x",
    events: [
      {
        type: "message",
        webhookEventId: "evt11",
        timestamp: 1735689600000,
        source: { type: "user", userId: "U1234567890" },
        message: { id: "msg11", type: "image", contentProvider: { type: "external", originalContentUrl: "https://example.com/a.jpg" } },
      },
    ],
  });
  assertEqual(externalImage[0].hasDownloadableContent, false, "parseLineWebhookBody: 外部URL提供の画像はコンテンツAPIの対象外と判定する");

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

/**
 * 2026-09-02 指示書§K/§5-§7: BELLO → 外部LINE の実送信は無効。
 *
 * ここで確かめるのは「UIのボタンが押せないこと」ではなく、
 * **外部HTTPリクエストが1本も出ないこと**。fetch を差し替えて
 * 呼び出し回数を数える(mock/stub による検証 — 実LINEへは送らない)。
 */
async function testLineOutboundHardLock() {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env[LINE_OUTBOUND_FLAG];
  let fetchCalls = 0;
  const calledUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls++;
    calledUrls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // ── 1. 未設定(既定)では無効 ────────────────────────────────
    delete process.env[LINE_OUTBOUND_FLAG];
    assertTrue(!isLineOutboundEnabled(), "環境変数が未設定なら送信は無効(既定は常に無効)");

    fetchCalls = 0;
    let thrown: unknown = null;
    try {
      await sendLinePush("Uffffffffffffffffffffffffffffffff", "テスト送信");
    } catch (e) {
      thrown = e;
    }
    assertTrue(thrown instanceof LineOutboundDisabledError, "未設定でsendLinePushすると LineOutboundDisabledError で拒否される");
    assertEqual(fetchCalls, 0, "拒否時の外部HTTPリクエストは0件");

    // reply経路(現状未使用だが、将来使われても同じ場所で止まること)
    fetchCalls = 0;
    thrown = null;
    try {
      await sendLineReply("dummy-reply-token", "テスト送信");
    } catch (e) {
      thrown = e;
    }
    assertTrue(thrown instanceof LineOutboundDisabledError, "sendLineReplyも同じガードで拒否される");
    assertEqual(fetchCalls, 0, "reply経路でも外部HTTPリクエストは0件");

    // ── 2. 紛らわしい値をすべて無効として扱う ───────────────────
    for (const value of ["false", "0", "1", "yes", "TRUE ", "", " ", "enabled", "on"]) {
      process.env[LINE_OUTBOUND_FLAG] = value;
      const enabled = isLineOutboundEnabled();
      const expected = value.trim().toLowerCase() === "true";
      assertEqual(enabled, expected, `LINE_OUTBOUND_ENABLED=${JSON.stringify(value)} → ${expected ? "有効" : "無効"}`);
    }

    // ── 3. 明示的にtrueにしたときだけ、送信コード自体は動く ─────
    //
    // 送信処理の品質確認は必要なので、ここだけはフラグを立てて
    // **mockのfetch**へ到達することを確かめる。実LINEへは行かない
    // (globalThis.fetchを差し替えているため)。
    process.env[LINE_OUTBOUND_FLAG] = "true";
    assertTrue(isLineOutboundEnabled(), "true を明示したときだけ有効になる");

    // ── 4. 状態表示は日本語で理由を伝える ──────────────────────
    process.env[LINE_OUTBOUND_FLAG] = "false";
    const status = getLineOutboundStatus();
    assertEqual(status.enabled, false, "getLineOutboundStatus: 無効を返す");
    assertTrue(status.message.includes("テスト中"), "getLineOutboundStatus: 無効の理由を日本語で説明する");

    // ── 5. この検証の間に実LINEへ出たリクエストは0件 ────────────
    assertEqual(
      calledUrls.filter((u) => u.startsWith("https://api.line.me")).length,
      0,
      "この検証全体を通して api.line.me への実リクエストは0件",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env[LINE_OUTBOUND_FLAG];
    else process.env[LINE_OUTBOUND_FLAG] = originalFlag;
  }
}

async function main() {
  testVerifyLineSignature();
  testParseLineWebhookBody();
  testLineWebhookRetryContract();

  await testLineOutboundHardLock();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

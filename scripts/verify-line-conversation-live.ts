/**
 * 公式LINEの2ターン問い合わせを、**実機で**確かめる(2026-09-03 追加指示 §26)。
 *
 *   AWS_PROFILE=Bello npm run verify:line-conversation-live
 *
 * ── 何をするのか ────────────────────────────────────────────────
 *
 *   1通目  https://bellointeri.base.shop/items/156144635
 *          3万円まで下げられますか？
 *   2通目  埼玉です
 *
 * を、正しい署名を付けて Staging の /api/line/webhook へ実際にPOSTする。
 * そのあとDynamoDBを読んで、
 *
 *   ・2通が同じ会話に入ったか
 *   ・2通目で商品・BASE URL・希望価格を失っていないか
 *   ・返信案が商品URLを聞き直していないか
 *
 * を確かめる。
 *
 * ── 実機でやる意味 ──────────────────────────────────────────────
 *
 * 単体テストは純粋関数を固定するもので、**配線**は確かめられない。
 * 今回直した不具合は文章の質ではなく、Webhook → 会話の特定 → 文脈の読み書き
 * → 商品特定 → 通知、という配線が途中で切れていたことだった。
 * 実際にPOSTしないと同じ壊れ方をまた見逃す。
 *
 * ── 副作用(必ず読むこと) ────────────────────────────────────────
 *
 *   ・Staging に会話が1件、メッセージが2件できる
 *   ・AIを2回呼ぶ(少額の課金)
 *   ・**社内LINEの通知先へ実際に通知が飛ぶ**
 *
 * 後片付けは --cleanup で行う(作った会話・メッセージ・返信案を消す)。
 * 通知は取り消せないので、テストと分かる顧客名を使う。
 */
import { createHmac } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { getLineChannelSecret } from "@/lib/messaging/line/tokenAccess";
import { parseConversationContext } from "@/lib/inquiry/conversationContext";

const BASE_URL =
  process.env.LINE_WEBHOOK_BASE_URL ??
  "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
const REGION = process.env.AWS_REGION || "us-west-2";

/** 実在しないことが明らかなID。実顧客の会話を汚さない。 */
const TEST_USER_ID = "Uffffffffffffffffffffffffffff0001";

const STEP1 = "https://bellointeri.base.shop/items/156144635\n3万円まで下げられますか？";
const STEP2 = "埼玉です";

const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✓" : "✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function tableName(model: string): string {
  const conv = process.env.CONVERSATION_TABLE_NAME;
  if (!conv) throw new Error("CONVERSATION_TABLE_NAME を指定してください。");
  const m = /^Conversation-(.+)$/.exec(conv);
  if (!m) throw new Error(`CONVERSATION_TABLE_NAME の形式が想定と違います: ${conv}`);
  return `${model}-${m[1]}`;
}

async function scanAll<T>(table: string, extra: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = (await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ...extra }))) as {
      Items?: T[];
      LastEvaluatedKey?: Record<string, unknown>;
    };
    out.push(...((res.Items ?? []) as T[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return out;
}

async function postWebhook(secret: string, text: string, messageId: string): Promise<number> {
  const body = JSON.stringify({
    destination: "test",
    events: [
      {
        type: "message",
        replyToken: "0".repeat(32),
        source: { type: "user", userId: TEST_USER_ID },
        timestamp: Date.now(),
        message: { id: messageId, type: "text", text },
      },
    ],
  });
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  const res = await fetch(`${BASE_URL}/api/line/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": signature },
    body,
  });
  return res.status;
}

interface ConversationRow {
  id: string;
  externalCustomerId?: string | null;
  inquiryContext?: string | null;
  inquiryContextVersion?: number | null;
}
interface MessageRow {
  id: string;
  conversationId: string;
  body: string;
  direction: string;
}
interface DraftRow {
  id: string;
  conversationId: string;
  draftText?: string | null;
  status?: string | null;
}

async function findTestConversations(): Promise<ConversationRow[]> {
  return scanAll<ConversationRow>(tableName("Conversation"), {
    FilterExpression: "externalCustomerId = :u",
    ExpressionAttributeValues: { ":u": TEST_USER_ID },
  });
}

async function cleanup() {
  console.log("=== 後片付け ===");
  const conversations = await findTestConversations();
  for (const c of conversations) {
    const messages = await scanAll<MessageRow>(tableName("Message"), {
      FilterExpression: "conversationId = :c",
      ExpressionAttributeValues: { ":c": c.id },
    });
    const drafts = await scanAll<DraftRow>(tableName("ReplyDraft"), {
      FilterExpression: "conversationId = :c",
      ExpressionAttributeValues: { ":c": c.id },
    });
    for (const m of messages) {
      await ddb.send(new DeleteCommand({ TableName: tableName("Message"), Key: { id: m.id } }));
    }
    for (const d of drafts) {
      await ddb.send(new DeleteCommand({ TableName: tableName("ReplyDraft"), Key: { id: d.id } }));
    }
    await ddb.send(new DeleteCommand({ TableName: tableName("Conversation"), Key: { id: c.id } }));
    console.log(`  会話 ${c.id} と メッセージ${messages.length}件 / 返信案${drafts.length}件 を削除しました。`);
  }
  if (conversations.length === 0) console.log("  対象はありませんでした。");
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }

  console.log("=== 公式LINE 2ターン実機検証 ===");
  console.log(`  宛先: ${BASE_URL}/api/line/webhook`);
  console.log("  ※ 社内LINEの通知先へ実際に通知が飛びます。\n");

  const before = await findTestConversations();
  if (before.length > 0) {
    console.log(`  前回のテスト会話が ${before.length} 件残っています。先に片付けます。`);
    await cleanup();
  }

  const secret = await getLineChannelSecret();
  if (!secret) throw new Error("LINEのチャネルシークレットを取得できませんでした。");

  const stamp = Date.now();

  // ── 1通目 ────────────────────────────────────────────────
  const status1 = await postWebhook(secret, STEP1, `test-${stamp}-1`);
  check(status1 === 200, "1通目のWebhookが200を返す", String(status1));

  const afterFirst = await findTestConversations();
  check(afterFirst.length === 1, "1通目で会話が1件できる", `${afterFirst.length}件`);
  if (afterFirst.length !== 1) {
    console.log("\n会話が作られていないため、以降の確認を行えません。");
    process.exit(1);
  }
  const conversationId = afterFirst[0].id;
  const context1 = parseConversationContext(afterFirst[0].inquiryContext ?? null);
  console.log(`  会話ID: ${conversationId}`);
  console.log(`  文脈の版: ${afterFirst[0].inquiryContextVersion ?? "(未保存)"}`);

  check(context1.identifiedProduct.baseItemId === "156144635", "1通目: BASE商品IDを保存している", String(context1.identifiedProduct.baseItemId));
  check(context1.negotiation.active, "1通目: 値下げ交渉として保存している");
  check(
    context1.negotiation.requestedTotalPriceYen === 30000,
    "1通目: 希望価格30,000円を保存している",
    String(context1.negotiation.requestedTotalPriceYen),
  );

  const drafts1 = await scanAll<DraftRow>(tableName("ReplyDraft"), {
    FilterExpression: "conversationId = :c",
    ExpressionAttributeValues: { ":c": conversationId },
  });
  check(drafts1.length === 1, "1通目: 返信案が1件できる", `${drafts1.length}件`);
  if (drafts1[0]?.draftText) {
    console.log(`\n  --- 1通目の返信案 ---\n  ${drafts1[0].draftText.replace(/\n/g, "\n  ")}\n`);
  }
  if (context1.pendingQuestions.length > 0) {
    console.log(`  確認待ち: ${context1.pendingQuestions.map((q) => q.field).join(", ")}`);
  }

  // ── 2通目 ────────────────────────────────────────────────
  const status2 = await postWebhook(secret, STEP2, `test-${stamp}-2`);
  check(status2 === 200, "2通目のWebhookが200を返す", String(status2));

  const afterSecond = await findTestConversations();
  check(afterSecond.length === 1, "2通目が同じ会話に入る(新しい会話を作らない)", `${afterSecond.length}件`);
  const context2 = parseConversationContext(afterSecond[0]?.inquiryContext ?? null);

  check(context2.identifiedProduct.baseItemId === "156144635", "2通目: 商品を失わない", String(context2.identifiedProduct.baseItemId));
  check(context2.identifiedProduct.baseItemUrl != null, "2通目: BASE URLを失わない", String(context2.identifiedProduct.baseItemUrl));
  check(
    context2.negotiation.requestedTotalPriceYen === 30000,
    "2通目: 希望価格を失わない",
    String(context2.negotiation.requestedTotalPriceYen),
  );
  check(context2.negotiation.active, "2通目: 値下げ交渉であることを失わない");
  check(context2.shipping.prefecture === "埼玉県", "2通目: 配送先が埼玉県になる", String(context2.shipping.prefecture));

  const drafts2 = await scanAll<DraftRow>(tableName("ReplyDraft"), {
    FilterExpression: "conversationId = :c",
    ExpressionAttributeValues: { ":c": conversationId },
  });
  const latest = drafts2.find((d) => !drafts1.some((p) => p.id === d.id));
  check(latest != null, "2通目: 返信案ができる");
  if (latest?.draftText) {
    console.log(`\n  --- 2通目の返信案 ---\n  ${latest.draftText.replace(/\n/g, "\n  ")}\n`);
    const asksAgain = /商品(?:の)?URL|商品名を|商品番号/.test(latest.draftText);
    check(!asksAgain, "2通目: 商品URL・商品名を聞き直していない");
  }

  const messages = await scanAll<MessageRow>(tableName("Message"), {
    FilterExpression: "conversationId = :c",
    ExpressionAttributeValues: { ":c": conversationId },
  });
  check(messages.filter((m) => m.direction === "INBOUND").length === 2, "受信メッセージが2件とも同じ会話にある");

  console.log(`\n${failures === 0 ? "すべて合格" : `${failures}件 不合格`}`);
  console.log(`後片付け: AWS_PROFILE=Bello CONVERSATION_TABLE_NAME=... npm run verify:line-conversation-live -- --cleanup`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("実機検証を実行できませんでした:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

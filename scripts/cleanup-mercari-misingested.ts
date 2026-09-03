/**
 * 誤って取り込んだ「問い合わせではないメール」の整理。
 *
 * ── 何を消すか。何を消さないか ──────────────────────────────────
 *
 * 修正前の検索条件 `from:mercari` は、メルカリShopsの問い合わせ通知だけで
 * なく mercari.jp のキャンペーン・新着通知・サポート返信・HubSpot配信まで
 * 拾っていた。それらが会話として取り込まれている。
 *
 * **推測で消さない。** 会話に残っている Message-ID から Gmail の元メールを
 * 引き直し、現在のパーサに掛けて `NOT_INQUIRY` と判定できたものだけを
 * 削除対象にする。次のいずれかに当たるものは**残す**:
 *
 *   - 元メールを引けなかった(判定できない)
 *   - パーサが問い合わせ(PRODUCT_INQUIRY / ORDER_MESSAGE)と判定した
 *   - 送信元が no-reply@mercari-shops.com である
 *
 * 古い実問い合わせは監査のために残す、という利用者の指示に沿う。
 *
 * ── 孤児を残さない ──────────────────────────────────────────────
 *
 * 会話を消すときは、その会話に紐づく Message / ReplyDraft /
 * NotificationDelivery もまとめて消す。順序は子→親。
 *
 * ── 使い方 ──────────────────────────────────────────────────────
 *
 *   npm run cleanup:mercari              # 判定して報告するだけ(既定)
 *   npm run cleanup:mercari -- --apply   # 実際に削除する
 */
process.env.CONVERSATION_TABLE_NAME =
  process.env.CONVERSATION_TABLE_NAME || "Conversation-j6up24p7lnczdmklzjdt3vrp4y-NONE";

import { runWithDirectData, serverDataClient, inventoryAuthMode } from "@/lib/amplify/dataClient";
import { getGmailCredentials } from "@/lib/messaging/email/gmailSecretStore";
import { parseMercariNotificationMail } from "@/lib/messaging/mercari/notificationMailParser";

const APPLY = process.argv.includes("--apply");
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface Row {
  id: string;
  channel?: string;
  externalCustomerId?: string;
  createdAt?: string;
}

async function accessToken(): Promise<string> {
  const c = await getGmailCredentials();
  if (!c) throw new Error("Gmail認証情報が読めません。判定できないため中止します。");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Gmailのトークン取得に失敗: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function decode(d?: string): string {
  return d ? Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
}
function collect(part: unknown, acc: { text: string[]; html: string[] }): void {
  const p = part as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return;
  const m = (p.mimeType ?? "").toLowerCase();
  if (p.body?.data) {
    if (m === "text/plain") acc.text.push(decode(p.body.data));
    else if (m === "text/html") acc.html.push(decode(p.body.data));
  }
  for (const c of p.parts ?? []) collect(c, acc);
}

/** Message-ID で元メールを引く。見つからなければ null(=判定できない→残す)。 */
async function fetchByMessageId(token: string, messageId: string) {
  const q = `rfc822msgid:${messageId.replace(/^<|>$/g, "")}`;
  const list = (await (
    await fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(q)}&maxResults=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { messages?: { id: string }[] };
  const hit = list.messages?.[0];
  if (!hit) return null;
  const msg = (await (
    await fetch(`${GMAIL_API}/messages/${hit.id}?format=full`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { payload?: unknown; internalDate?: string };
  const headers = ((msg.payload as { headers?: { name: string; value: string }[] })?.headers ?? []);
  const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const acc = { text: [] as string[], html: [] as string[] };
  collect(msg.payload, acc);
  return {
    subject: h("Subject"),
    from: h("From"),
    text: acc.text.join("\n"),
    html: acc.html.join("\n"),
    messageId,
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
  };
}

async function main() {
  const token = await accessToken();

  await runWithDirectData(async () => {
    const convs = ((await serverDataClient.models.Conversation.list({ ...inventoryAuthMode, limit: 500 })).data as unknown as Row[])
      .filter((c) => c.channel === "MERCARI_SHOPS")
      .filter((c) => String(c.externalCustomerId ?? "").startsWith("mercari-mail:"));

    console.log(`旧キー(mercari-mail:)の会話: ${convs.length}件\n`);

    const toDelete: { conv: Row; why: string }[] = [];
    const toKeep: { conv: Row; why: string }[] = [];

    for (const c of convs) {
      const messageId = String(c.externalCustomerId).replace(/^mercari-mail:/, "");
      const mail = await fetchByMessageId(token, messageId);

      if (!mail) {
        toKeep.push({ conv: c, why: "元メールを引けず判定できない" });
        continue;
      }
      // 送信元がメルカリShopsなら、問い合わせ通知の可能性があるので残す。
      if (/no-reply@mercari-shops\.com/i.test(mail.from)) {
        const parsed = parseMercariNotificationMail(mail);
        if (parsed.status !== "NOT_INQUIRY") {
          toKeep.push({ conv: c, why: `実問い合わせ(${parsed.kind})` });
          continue;
        }
        toKeep.push({ conv: c, why: "mercari-shops発だが問い合わせ通知ではない(念のため残す)" });
        continue;
      }
      const parsed = parseMercariNotificationMail(mail);
      if (parsed.status !== "NOT_INQUIRY") {
        toKeep.push({ conv: c, why: `問い合わせと判定された(${parsed.kind})` });
        continue;
      }
      toDelete.push({ conv: c, why: `問い合わせではない / From: ${mail.from.slice(0, 40)} / 件名: ${mail.subject.slice(0, 40)}` });
    }

    console.log(`--- 削除対象 ${toDelete.length}件 ---`);
    for (const d of toDelete) console.log(`  ${d.conv.createdAt}  ${d.why}`);
    console.log(`\n--- 残す ${toKeep.length}件 ---`);
    for (const k of toKeep) console.log(`  ${k.conv.createdAt}  ${k.why}`);

    if (!APPLY) {
      console.log("\n(--apply が無いため、何も削除していません)");
      return;
    }

    // 子から順に消す。孤児を残さない。
    const delIds = new Set(toDelete.map((d) => d.conv.id));
    const msgs = ((await serverDataClient.models.Message.list({ ...inventoryAuthMode, limit: 900 })).data as unknown as { id: string; conversationId?: string }[])
      .filter((m) => m.conversationId && delIds.has(m.conversationId));
    const drafts = ((await serverDataClient.models.ReplyDraft.list({ ...inventoryAuthMode, limit: 900 })).data as unknown as { id: string; conversationId?: string }[])
      .filter((d) => d.conversationId && delIds.has(d.conversationId));
    const dels = ((await serverDataClient.models.NotificationDelivery.list({ ...inventoryAuthMode, limit: 900 })).data as unknown as { id: string; conversationId?: string }[])
      .filter((d) => d.conversationId && delIds.has(d.conversationId));

    console.log(`\n削除前: 会話${toDelete.length} / メッセージ${msgs.length} / 返信案${drafts.length} / 通知${dels.length}`);

    for (const d of dels) await serverDataClient.models.NotificationDelivery.delete({ id: d.id }, inventoryAuthMode);
    for (const d of drafts) await serverDataClient.models.ReplyDraft.delete({ id: d.id }, inventoryAuthMode);
    for (const m of msgs) await serverDataClient.models.Message.delete({ id: m.id }, inventoryAuthMode);
    for (const d of toDelete) await serverDataClient.models.Conversation.delete({ id: d.conv.id }, inventoryAuthMode);

    // 参照整合性の確認: 消した会話を指す行が残っていないこと。
    const leftoverMsgs = ((await serverDataClient.models.Message.list({ ...inventoryAuthMode, limit: 900 })).data as unknown as { conversationId?: string }[])
      .filter((m) => m.conversationId && delIds.has(m.conversationId)).length;
    const leftoverDrafts = ((await serverDataClient.models.ReplyDraft.list({ ...inventoryAuthMode, limit: 900 })).data as unknown as { conversationId?: string }[])
      .filter((d) => d.conversationId && delIds.has(d.conversationId)).length;
    const leftoverDels = ((await serverDataClient.models.NotificationDelivery.list({ ...inventoryAuthMode, limit: 900 })).data as unknown as { conversationId?: string }[])
      .filter((d) => d.conversationId && delIds.has(d.conversationId)).length;

    console.log(`削除後の孤児: メッセージ${leftoverMsgs} / 返信案${leftoverDrafts} / 通知${leftoverDels}  ← すべて0であること`);
  });
}

main().catch((e) => {
  console.error("失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
});

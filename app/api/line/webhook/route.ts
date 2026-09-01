import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/messaging/line/signature";
import { getLineChannelSecret } from "@/lib/messaging/line/tokenAccess";
import { fetchLineProfile } from "@/lib/messaging/line/profile";
import { fetchLineMessageContent } from "@/lib/messaging/line/content";
import { saveIncomingAttachment } from "@/lib/messaging/attachmentStore";
import { parseLineWebhookBody } from "@/lib/messaging/line/adapter";
import { recordIncomingWebhookMessage, classifyWebhookStoreFailure, type WebhookStoreFailure } from "@/lib/messaging/webhookStore";
import type { LineWebhookBody } from "@/lib/messaging/line/types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §51/§87: LINE Messaging APIの
 * Webhook受信エンドポイント。認証はCognitoログインではなく
 * x-line-signature(§87 Webhook Security)で行う — この経路は
 * inventoryユーザーのログインセッションを一切要求しない、LINEの
 * サーバーだけが正しい署名を作れる、という前提に立つ(通常のADMIN権限
 * チェックはここには存在しない、それで正しい設計)。
 *
 * 【重要: 生のボディをそのまま使う】署名検証はJSON.parse前の生の
 * リクエストボディ文字列に対して行う(lib/messaging/line/signature.ts
 * のコメント参照) — request.text()で取得し、検証後にJSON.parseする。
 *
 * 【冪等性】LINEはWebhookをat-least-onceで配送する(再送されうる)。
 * recordIncomingMessageがexternalMessageId(LINEのmessage.id)で重複を
 * 検出しスキップするため、このroute自体は「何度呼ばれても安全」。
 *
 * 【応答速度】LINE公式ドキュメントの推奨に従い、実処理が失敗しても
 * (DB書き込みエラー等)LINE側には200を返す方針は取らない —
 * ここでは正直に失敗を401/500として返し、LINEの自動再送に任せる
 * (recordIncomingMessageの冪等性チェックのおかげで再送は安全)。
 *
 * 【BLOCKED_BY_USER】このURL自体は実装済みだが、実際にLINE Developers
 * ConsoleのWebhook URL欄へ登録するには、このアプリの実際の公開HTTPS
 * URLが必要。
 *
 * ※以前ここには「AWSへの実デプロイができていない(sts:GetCallerIdentity
 *   失敗)ため登録できていない」と書かれていたが、これは陳腐化している。
 *   Stagingは実際にデプロイ済みで、Webhookの登録先URLは
 *     https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com/api/line/webhook
 *   である。未完了なのはデプロイではなく、
 *     1. LINE Developers ConsoleでこのURLをWebhook URLへ登録すること
 *     2. Channel Secret / Channel Access Tokenを設定画面から保存すること
 *   の2点で、どちらも本人操作(BLOCKED_BY_USER)。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const channelSecret = await getLineChannelSecret();
  if (!channelSecret) {
    console.error("[line webhook] LINE_CHANNEL_SECRETが未設定のため受信を処理できません。");
    return new NextResponse("LINE integration not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    console.error("[line webhook] 署名検証に失敗しました。");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const normalized = parseLineWebhookBody(body);
  let failedCount = 0;
  // 何で失敗したのかの種別だけを集める（中身は持たない）。
  const failures = new Set<WebhookStoreFailure>();
  // 同じ相手から複数イベントが来ることがあるので、プロフィールの取得は
  // 1回のWebhook内で userId ごとに1度だけにする。
  const profileCache = new Map<string, { displayName: string | null; source: string | null }>();

  for (const msg of normalized) {
    try {
      // ── 顧客名 ─────────────────────────────────────────────
      // 「不明な顧客」の原因は、ここでプロフィールを取りに行っていな
      // かったこと。取れなかった場合は名前を作らず null のままにする
      // (lib/messaging/line/profile.ts のコメント参照)。
      let profile = profileCache.get(msg.externalCustomerId);
      if (!profile) {
        const fetched = await fetchLineProfile(msg.externalCustomerId);
        profile = fetched.ok
          ? { displayName: fetched.profile.displayName, source: "LINE_PROFILE" }
          : { displayName: null, source: `LINE_PROFILE_FAILED:${fetched.reason}` };
        if (!fetched.ok) {
          console.warn("[line webhook] プロフィールを取得できませんでした", { reason: fetched.reason });
        }
        profileCache.set(msg.externalCustomerId, profile);
      }

      // ── 添付(画像等) ───────────────────────────────────────
      // 取得は「できたら保存する」であって、失敗してもメッセージ自体は
      // 必ず記録する。画像が取れなかったことと、問い合わせが無かったことは
      // 全く違う(§4「画像取得失敗時はConversation自体を失わない」)。
      let attachment: {
        attachmentStorageKey?: string | null;
        attachmentContentType?: string | null;
        attachmentSizeBytes?: number | null;
        attachmentStatus?: "NONE" | "PENDING" | "STORED" | "FAILED";
        attachmentError?: string | null;
      } = { attachmentStatus: msg.hasDownloadableContent ? "PENDING" : "NONE" };

      if (msg.hasDownloadableContent) {
        const content = await fetchLineMessageContent(msg.externalMessageId);
        if (content.ok) {
          const saved = await saveIncomingAttachment({
            // 会話IDはこの時点ではまだ確定していないので、相手のIDで分ける。
            // 会話単位で見たいときは Message.conversationId から辿れる。
            conversationId: msg.externalCustomerId,
            externalMessageId: msg.externalMessageId,
            body: content.body,
            contentType: content.contentType,
          });
          attachment = saved.ok
            ? {
                attachmentStorageKey: saved.storageKey,
                attachmentContentType: saved.contentType,
                attachmentSizeBytes: saved.sizeBytes,
                attachmentStatus: "STORED",
              }
            : { attachmentStatus: "FAILED", attachmentError: saved.reason };
        } else {
          attachment = { attachmentStatus: "FAILED", attachmentError: content.reason };
        }
      }

      await recordIncomingWebhookMessage({
        channel: "LINE",
        externalCustomerId: msg.externalCustomerId,
        externalMessageId: msg.externalMessageId,
        body: msg.body,
        externalSentAt: msg.externalSentAt,
        customerDisplayName: profile.displayName,
        customerNameSource: profile.source,
        customerNameFetchedAt: new Date().toISOString(),
        contentKind: msg.contentKind,
        ...attachment,
      });
    } catch (err) {
      // 1件の失敗で他のイベントの処理を止めない — 残りは処理を続ける。
      failedCount++;
      failures.add(classifyWebhookStoreFailure(err));
      console.error("[line webhook] 受信メッセージの保存に失敗:", err instanceof Error ? err.message : err);
    }
  }

  // 1件でも取りこぼしたら 2xx を返さない。
  //
  // 以前はここで常に `{ ok: true }`(200)を返していた。LINEは2xxを
  // 「受信成功」とみなして**再送しない**ため、記録に失敗したメッセージは
  // そのまま失われていた——「失敗してもLINE側の再送で安全に再処理できる」
  // という当時のコメントの前提が、200を返している限り成立していなかった。
  //
  // 500を返せばLINEは同じイベント群を再送する。再送で重複が生まれないことは
  // recordIncomingMessageのidempotency(externalMessageIdのGSIで既存を検出し
  // `{deduped:true}`を返す)が保証しており、成功済みのメッセージは二重登録
  // されない。よって「全部再送させる」のが正しく、かつ安全な選択。
  if (failedCount > 0) {
    return NextResponse.json({ ok: false, failed: failedCount, reasons: [...failures] }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

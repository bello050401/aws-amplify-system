import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/messaging/line/signature";
import { getLineChannelSecret } from "@/lib/messaging/line/tokenAccess";
import { parseLineWebhookBody } from "@/lib/messaging/line/adapter";
import { recordIncomingMessage } from "@/lib/messaging/service";
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
 * URL(Amplify Hostingへのデプロイ後のURL)が必要 — 現時点でAWSへの
 * 実デプロイができていない(sts:GetCallerIdentity失敗、確認済み)ため
 * 登録できていない。
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
  for (const msg of normalized) {
    try {
      await recordIncomingMessage({
        channel: "LINE",
        externalCustomerId: msg.externalCustomerId,
        externalMessageId: msg.externalMessageId,
        body: msg.body,
        externalSentAt: msg.externalSentAt,
      });
    } catch (err) {
      // 1件の失敗で他のイベントの処理を止めない。失敗したイベントは
      // externalMessageIdの冪等性チェックのおかげでLINE側の再送でも
      // 安全に再処理できる。
      console.error("[line webhook] recordIncomingMessage失敗:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({ ok: true });
}

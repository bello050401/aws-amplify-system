import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/messaging/line/signature";
import { getNotifyBotChannelSecret } from "@/lib/messaging/lineNotify/secretStore";
import { fetchNotifyTargetProfile } from "@/lib/messaging/lineNotify/client";
import { clearNotifyTarget, registerNotifyTarget } from "@/lib/messaging/lineNotify/settingsStore";
import { runWithDirectData } from "@/lib/amplify/dataClient";

/**
 * 2026-09-03 指示書 §6/§4-3: **社内通知用**LINE BotのWebhook。
 *
 * ── なぜ既存の /api/line/webhook と分けるのか ────────────────────
 *
 * 別チャネルだから。既存のWebhookは**顧客が問い合わせてくる公式LINE**用
 * で、届いたメッセージを Conversation/Message として取り込む。こちらは
 * **社内通知Bot**用で、やることは1つだけ:
 *
 *     友だち追加(follow)されたら、その userId を通知先として登録する
 *
 * 1つのエンドポイントで両方を捌こうとすると、署名検証に使う Channel
 * Secret がチャネルごとに違うため、どちらの秘密で検証すべきか決められ
 * ない。分けるのが正しい。
 *
 * ── なぜ userId を自動登録するのか ──────────────────────────────
 *
 * LINEのユーザーID(U から始まる33文字)は人が読んで意味の分かる値では
 * ないので、コンソールから手で転記させると高確率で間違える。しかも
 * **間違えても送信APIはエラーを返さないことがある** —— 通知は「成功」
 * したまま誰にも届かず、一番気づきにくい壊れ方をする。
 * 実際に友だち追加したイベントからしか登録しない。
 *
 * ── 登録先の設定 ────────────────────────────────────────────────
 *
 * LINE Developers Console のこのチャネルの Webhook URL へ
 *   https://<このアプリの公開URL>/api/line/notify-webhook
 * を設定する(本人操作)。設定しなくても通知の送信自体は動くが、
 * その場合は通知先が登録されないため送り先が無い状態になる。
 */

interface NotifyWebhookEvent {
  type?: string;
  source?: { type?: string; userId?: string };
}

interface NotifyWebhookBody {
  events?: NotifyWebhookEvent[];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const channelSecret = await getNotifyBotChannelSecret();
  if (!channelSecret) {
    console.error("[lineNotify webhook] 通知BotのChannel Secretが未設定のため受信を処理できません。");
    return new NextResponse("Notify bot not configured", { status: 500 });
  }

  // 署名検証は JSON.parse **前**の生ボディに対して行う(既存の
  // lib/messaging/line/signature.ts の契約。ここで先にparseすると
  // 検証が通らなくなる)。
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    console.error("[lineNotify webhook] 署名検証に失敗しました。");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: NotifyWebhookBody;
  try {
    body = JSON.parse(rawBody) as NotifyWebhookBody;
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  for (const event of body.events ?? []) {
    // 通知先は1人(大原さん本人)を想定しているので、グループ・ルームからの
    // イベントは無視する。誤ってグループへ追加されたときに、そのグループ
    // 全員へ仕入価格が飛ぶのを防ぐ。
    const userId = event.source?.type === "user" ? event.source.userId : undefined;
    if (!userId) continue;

    try {
      // ★ このrouteも**未認証**。LINEからのPOSTでCookieもセッションも無い。
      //
      // LineNotifySettings の読み書きは serverDataClient(userPool認証)を
      // 通るため、そのままではAppSyncに弾かれて**黙って登録されない**。
      // 実際、friend追加のイベントは200で返るのに通知先が未登録のまま、
      // という状態を実機で踏んだ。runWithDirectData でDynamoDB直結にする
      // (lib/amplify/dataClient.ts、LINE Webhook側と同じ扱い)。
      await runWithDirectData(async () => {
        if (event.type === "follow") {
          const profile = await fetchNotifyTargetProfile(userId);
          await registerNotifyTarget({ userId, displayName: profile.displayName });
          console.info("[lineNotify webhook] 通知先を登録しました。");
        } else if (event.type === "unfollow") {
          // ブロックされた宛先へ送り続けない。再試行が無駄に失敗し続け、
          // DEAD_LETTER が溜まるだけになる。
          await clearNotifyTarget();
          console.info("[lineNotify webhook] 通知先を解除しました。");
        }
      });
      // message等その他のイベントは何もしない。この Bot は社内通知の
      // 送信専用で、受け取ったメッセージを処理する役割を持たない。
    } catch (err) {
      // 1件の失敗で 500 を返すと、LINEが同じWebhookを再送し続ける。
      // 登録は次の友だち追加でやり直せるので、ログを残して 200 で返す。
      console.error("[lineNotify webhook] イベント処理に失敗しました", {
        type: event.type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true });
}

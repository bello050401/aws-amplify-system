import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/messaging/line/signature";
import { getNotifyBotChannelSecret } from "@/lib/messaging/lineNotify/secretStore";
import { fetchNotifyTargetProfile } from "@/lib/messaging/lineNotify/client";
import { clearNotifyTarget, recordWebhookEvent, registerNotifyTarget } from "@/lib/messaging/lineNotify/settingsStore";
import { runWithDirectData } from "@/lib/amplify/dataClient";
import { decideNotifyRegistration } from "@/lib/messaging/lineNotify/registrationPolicy";

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

  // §6 受信そのものを残す。
  //
  // このrouteは**何が起きても200を返す**(500だとLINEが再送し続けるため)。
  // その代償として、失敗が呼び出し側から見えない。SSRのconsoleログも
  // CloudWatchへ届かない(d44d8e0)。結果、LINEから200で返っている記録は
  // あるのに通知先が登録されない、という状態の原因を絞り込めなかった。
  // 受け取ったイベント種別と処理結果をDBへ残し、画面から見えるようにする。
  //
  // **userIdは残さない。** 画面表示用の診断情報であって、通知先の登録は
  // あくまでイベント本体から行う(転記による取り違えを防ぐ設計)。
  const trace: string[] = [];
  if ((body.events ?? []).length === 0) trace.push("イベント無し(疎通確認)");

  for (const event of body.events ?? []) {
    const decision = decideNotifyRegistration(event);
    if (decision.action === "IGNORE") {
      trace.push(decision.reason);
      continue;
    }

    try {
      // ★ このrouteも**未認証**。LINEからのPOSTでCookieもセッションも無い。
      //
      // LineNotifySettings の読み書きは serverDataClient(userPool認証)を
      // 通るため、そのままではAppSyncに弾かれて**黙って登録されない**。
      // 実際、friend追加のイベントは200で返るのに通知先が未登録のまま、
      // という状態を実機で踏んだ。runWithDirectData でDynamoDB直結にする
      // (lib/amplify/dataClient.ts、LINE Webhook側と同じ扱い)。
      await runWithDirectData(async () => {
        if (decision.action === "CLEAR") {
          // ブロックされた宛先へ送り続けない。再試行が無駄に失敗し続け、
          // DEAD_LETTER が溜まるだけになる。
          await clearNotifyTarget();
          trace.push("unfollow: 通知先を解除しました");
          console.info("[lineNotify webhook] 通知先を解除しました。");
          return;
        }

        const profile = await fetchNotifyTargetProfile(decision.userId);
        await registerNotifyTarget({ userId: decision.userId, displayName: profile.displayName });
        trace.push(`${event.type ?? "不明"}: 通知先を登録しました`);
        console.info("[lineNotify webhook] 通知先を登録しました。", { eventType: event.type });
      });
      // 受け取ったメッセージの中身は扱わない。この Bot は社内通知の
      // 送信専用で、返信や会話の取り込みは行わない —— 登録のために
      // userId だけを見る。
    } catch (err) {
      // 1件の失敗で 500 を返すと、LINEが同じWebhookを再送し続ける。
      // 登録は次のイベントでやり直せるので、ログを残して 200 で返す。
      const message = err instanceof Error ? err.message : String(err);
      trace.push(`${event.type ?? "不明"}: 失敗 — ${message}`);
      console.error("[lineNotify webhook] イベント処理に失敗しました", { type: event.type, message });
    }
  }

  // 記録はDynamoDB直結側で行う。ここもCookieが無い未認証経路なので、
  // 通常の serverDataClient では書けない。
  await runWithDirectData(() => recordWebhookEvent(trace.join(" / ") || "処理対象のイベントがありませんでした"));

  return NextResponse.json({ ok: true });
}

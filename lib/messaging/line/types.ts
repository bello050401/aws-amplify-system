/**
 * LINE Messaging API Webhookイベントの型(公式ドキュメントで安定して
 * 公開されているフィールドのみ — Mercari Shopsの問い合わせAPIと違い、
 * LINE Messaging APIは長期間仕様が安定した広く使われる公開APIのため、
 * 断片的な[UNVERIFIED]扱いにする必要はない)。このアプリで実際に使う
 * フィールドのみを型に起こしており、LINEが送ってくる全フィールドの
 * 網羅ではない。
 */
export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

export interface LineWebhookEvent {
  type: string; // "message" | "follow" | "unfollow" | "postback" 等 — 今回はmessageのみ処理する
  webhookEventId: string; // 再送検知用の一意ID(§51: redelivery-safe idempotency)
  deliveryContext?: { isRedelivery: boolean };
  timestamp: number;
  source?: { type: string; userId?: string; groupId?: string; roomId?: string };
  replyToken?: string;
  message?: {
    id: string;
    type: string; // "text" | "image" | "sticker" 等 — 今回はtextのみ処理する
    text?: string;
  };
}

/** app/api/line/webhook/route.tsが受信メッセージを処理した後にlib/messaging/service.tsへ渡す正規化済みの形。 */
export interface NormalizedLineIncomingMessage {
  externalMessageId: string; // message.id(冪等性チェックのキー)
  externalCustomerId: string; // source.userId(1:1チャットの相手を一意に識別)
  body: string;
  externalSentAt: string; // event.timestampをISO文字列化したもの
  replyToken: string | null;
}

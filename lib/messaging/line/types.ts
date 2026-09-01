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
    /** "text" | "image" | "sticker" | "video" | "audio" | "file" | "location" */
    type: string;
    text?: string;
    /**
     * 画像・動画・音声で、コンテンツをどこから取れるか。
     * "line" ならLINEのコンテンツAPIから、"external" なら外部URLから。
     * 型に起こしているのは、取得可否を保存時に判断するため。
     */
    contentProvider?: { type: string; originalContentUrl?: string; previewImageUrl?: string };
  };
}

/** BELLO側で扱うメッセージ種別。amplify/data/resource.ts の MessageContentKind と対応する。 */
export type LineContentKind = "TEXT" | "IMAGE" | "STICKER" | "FILE" | "OTHER";

/** app/api/line/webhook/route.tsが受信メッセージを処理した後にlib/messaging/service.tsへ渡す正規化済みの形。 */
export interface NormalizedLineIncomingMessage {
  externalMessageId: string; // message.id(冪等性チェックのキー)
  externalCustomerId: string; // source.userId(1:1チャットの相手を一意に識別)
  /**
   * 本文。画像・スタンプでは空になり得る。
   *
   * 【2026-09-02】以前は本文が取れないイベントを丸ごと捨てていたため、
   * 画像を送られると会話に何も残らなかった。本文の有無で捨てず、
   * 種別(contentKind)で扱いを分ける。
   */
  body: string;
  contentKind: LineContentKind;
  /** LINEのコンテンツAPIから取得できる添付か(画像等)。 */
  hasDownloadableContent: boolean;
  externalSentAt: string; // event.timestampをISO文字列化したもの
  replyToken: string | null;
}

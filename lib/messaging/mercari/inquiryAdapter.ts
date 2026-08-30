import "server-only";

/**
 * BELLO統合業務OS指示書(2026-08-30) §32/§39/§51/§166: Mercari Shops
 * 問い合わせAPIの調査結果と、今回のラウンドでの実装範囲。
 *
 * 【WebSearch経由で確認できた実際の情報】(このsandbox環境から
 * api.mercari-shops.com/docs/index.htmlへ直接到達できないため、検索
 * 結果の要約経由 — §112「実装時に公式schemaを再確認する」対応が必要):
 * - `addInquiryMessage`というGraphQLミューテーションが実在し、入力型
 *   `AddInquiryMessageInput`・戻り値型`AddInquiryMessagePayload`を持つ。
 *   `AddInquiryMessagePayload`のフィールドとして
 *   attachments/body/from/id/inquiryId/sentAt/statusが確認できた。
 * - Webhook topicとして`INQUIRY_MESSAGE_ADMIN_DELETED`が実在すること
 *   を確認(公式ドキュメントのwebhook一覧クエリの一部として言及)。
 *   master指示書付録にある`INQUIRY_MESSAGE_CREATED`/`INQUIRY_RESOLVED`
 *   はこの検索では直接確認できなかった(実在しないという意味ではなく、
 *   検索結果の要約に含まれていなかっただけ — [UNVERIFIED])。
 * - 問い合わせ一覧を取得する側のQuery名(`inquiry`/`inquiries`/
 *   `inquiryMessages`)、`AddInquiryMessageInput`の具体的なフィールド
 *   構成、Webhookペイロードの実際のJSON形状、署名検証方式は確認できて
 *   いない([UNVERIFIED])。
 *
 * 【第二次完全完遂指示(2026-08-30)での再調査】「未確認はBLOCKED理由
 * にならない」との指摘を受け、改めて複数の切り口で再調査した:
 * (1) Webhook自体の提供形態を確認 — 「WebhookはAPI利用者専用の機能で、
 *     管理画面からは設定できず、createWebhook APIでのみ設定可能」と
 *     いう記述を確認(=Webhook機構自体は実在し、createWebhookという
 *     ミューテーション名も実在することの追加確認)。
 * (2) updateProductミューテーションについても再調査し、
 *     `UpdateProductInput`が`shippingConfigurationId`/
 *     `channelListingScope`フィールドを持つことを確認(が、price/
 *     status等の肝心のフィールド名は依然未確認)。
 * (3) GitHub上の非公式クライアント2件(mercari-shops-api-client,
 *     mercapi_shops)のソースを直接fetchしたが、いずれも読み取り専用
 *     (search/landing取得)のクライアントで、書き込み系ミューテーション
 *     の実装は含まれていなかった。
 * (4) sandbox GraphQLエンドポイント(api.mercari-shops-sandbox.com)への
 *     直接到達を試みたが、このsandbox環境のegress proxyでブロックされた
 *     (EGRESS_BLOCKED)。
 * 結論は変わらず: Webhook署名検証方式・問い合わせ一覧Query・
 * AddInquiryMessageInputの詳細フィールドは、いずれも実際のMercari
 * Shops開発者ポータルへのアクセス(契約者専用)無しには確定できない。
 * これは「調べていない」のではなく、上記4つの具体的な経路をすべて
 * 試した上でのBLOCKED_BY_EXTERNAL_SERVICE。
 *
 * 【今回未実装とした理由】上記の断片的な情報だけでは、実際に
 * 動作するリクエストを組み立てられない(特にWebhook署名検証の方式が
 * 不明なまま受信エンドポイントを公開するのは、検証されていないリクエ
 * ストを無条件に信頼することになりセキュリティ上危険 — §87 Webhook
 * Security「official validation requirements」に反する)。憶測で
 * 実装してAPIコールを試すことも、実際のMercari契約・ネットワーク到達
 * が無い状態では検証しようがなく、fake success(§157)につながる
 * リスクがある。
 *
 * そのため今回は:
 *   - lib/messaging/service.tsに、実チャネルからの受信を将来ここへ
 *     接続できる形(recordIncomingMessage相当の拡張ポイント)を用意。
 *   - このファイルには、実装時にすぐ使える程度まで調査結果を書き残す。
 *   - 実際にAPIを呼ぶ関数は未実装のまま、呼ばれたら明確に
 *     「未実装」と分かるエラーを投げるプレースホルダのみ用意する
 *     (黙って何もしない関数を残さない — §156「自分で実装可能なTODOを
 *     残して終了しない」の裏返しとして、少なくとも「なぜ実装していな
 *     いか」を呼び出し時にも分かるようにする)。
 *
 * 完了報告での分類: BLOCKED_BY_EXTERNAL_SERVICE
 * (Webhook署名検証方式・問い合わせ一覧Query・Input型の詳細フィールドが
 * 実際のMercari Shops APIドキュメントへの到達なしには確定できないため)。
 */

/** [UNVERIFIED] WebSearchで確認できたフィールド名のみを反映した戻り値型の断片。実際の型定義はMercari公式ドキュメントへの到達後に確定させること。 */
export interface MercariInquiryMessage {
  id: string;
  inquiryId: string;
  body: string;
  from: string;
  sentAt: string;
  status: string;
  attachments: unknown[];
}

export async function fetchMercariInquiries(): Promise<never> {
  throw new Error(
    "Mercari問い合わせAPI連携は未実装です（Webhook署名検証方式・問い合わせ一覧クエリの実Schemaが未確認のため）。lib/messaging/mercari/inquiryAdapter.tsのファイル冒頭コメント参照。",
  );
}

export async function sendMercariInquiryReply(inquiryId: string, body: string): Promise<never> {
  throw new Error(
    `Mercari問い合わせ(${inquiryId})への返信送信は未実装です（addInquiryMessageミューテーションの入力フィールド詳細が未確認のため、本文「${body.slice(0, 20)}...」は送信されていません）。lib/messaging/mercari/inquiryAdapter.tsのファイル冒頭コメント参照。`,
  );
}

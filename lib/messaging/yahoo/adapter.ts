import "server-only";

/**
 * BELLO統合業務OS指示書(2026-08-30) §32/§39/§51以降(Priority 6):
 * Yahoo!オークションストアの公式API調査結果と、今回のラウンドでの
 * 実装範囲。lib/messaging/mercari/inquiryAdapter.tsと同じ「正直な
 * 未実装」パターン。
 *
 * 【実施した調査】WebSearchで複数クエリを実行:
 *   - "Yahoo!オークション ストア出品者 公式API 出品 メッセージ送受信 提供状況 2026"
 *   - "ヤフオク ストア 出品者 API 公開 個人 開発者向け ヤフオクAPI 提供終了 または 非公開"
 *
 * 【確認できたこと】
 *   - Yahoo!デベロッパーネットワーク(developer.yahoo.co.jp)が提供する
 *     出品管理API・商品登録API・注文検索API・注文詳細APIは、いずれも
 *     「Yahoo!ショッピング」向けのAPI(developer.yahoo.co.jp/webapi/
 *     shopping/配下)であり、「Yahoo!オークション」(ヤフオク)向けの
 *     ものではない — 両者はYahoo! JAPAN内の別サービスであり、
 *     ショッピング側のAPIをオークションストアの運営に転用することは
 *     できない。
 *   - ヤフオク自体のAPI(検索・カテゴリ取得等)に関する現在有効な結果は
 *     ほぼ見つからず、見つかった資料は2008〜2013年頃のもの(入札履歴
 *     取得等、閲覧・検索用途)だった。出品作成・価格変更・メッセージ
 *     送受信・Webhookのいずれについても、現在も提供されている公式API
 *     の存在を示す一次情報は見つからなかった。
 *
 * 【確認できなかったこと(≠存在しないことの証明)】
 *   - ヤフオクストア専用の非公開パートナーAPI(招待制等)が別途存在する
 *     かどうかは、公開されているWebSearchの範囲では確認できない
 *     ([UNVERIFIED])。仮に存在する場合、利用には個別契約が必要で
 *     あり、いずれにせよBELLOが独自に実装を進められる領域ではない。
 *
 * 【今回の対応】上記の通り、一般に公開された、個人/法人が自由に申請
 * して使える「ヤフオクストア出品管理・メッセージ送受信API」の存在を
 * 確認できなかったため、実装を行わない。憶測でAPIエンドポイントを
 * 組み立てて実装することは、存在しないAPIへのリクエストを送るだけの
 * 無意味なコードになり、かつ「実装した」という誤解を招く(§157 fake
 * success禁止)。
 *
 * 【第二次完全完遂指示(2026-08-30)での追加調査】§14「代替経路
 * (公式通知メールのEmail ingestion化)が無いか検討する」に対応し、
 * ヤフオクの「落札通知メール」を調査した。ヤフオクは出品者の登録
 * 連絡先メールアドレスへ、落札成立時に自動通知メール(出品者が
 * 任意メッセージを追記可能、2020年5月からHTML形式にも対応)を送信する
 * ことを確認 — これは実在する、規約に沿った公式の通知経路である
 * (スクレイピングではない)。
 *
 * 設計上の結論: lib/messaging/email/sesAdapter.tsのSES受信機能
 * (現状BLOCKED_BY_USER — 送信ドメインの検証がユーザーの意思決定待ち、
 * 同ファイル参照)が実装されれば、ヤフオクの登録連絡先メールアドレスを
 * そのSES検証済みドメイン配下のアドレスに設定するだけで、「落札通知
 * メール受信→Conversation化」を他チャネルと全く同じ
 * recordIncomingMessage経路に接続できる可能性が高い(出品作成・価格
 * 変更・双方向メッセージ送信は依然として公式API不在のため対象外だが、
 * 「落札の事実を検知してConversationを開始する」ことは可能になる)。
 * ただしこれもEmail受信と同じ根本原因(AWS認証情報未復旧)で今回は
 * 実装まで到達していない。
 *
 * 完了報告での分類: BLOCKED_BY_EXTERNAL_SERVICE
 * (一般提供されているオークションストア向け出品/メッセージAPIの
 * 存在を確認できなかったため。もし将来Yahoo! JAPANとの個別契約で
 * 専用APIへのアクセスが得られた場合は、そのAPI仕様に基づいて
 * lib/messaging/service.tsのrecordIncomingMessage/sendReplyへ他の
 * チャネルと同じ形で接続できる)。落札通知メールのEmail ingestion化
 * 自体はBLOCKED_BY_USER(SES受信ドメイン確定待ち)。
 */
export async function fetchYahooAuctionMessages(): Promise<never> {
  throw new Error(
    "Yahoo!オークションストアからのメッセージ受信は未実装です（一般提供されている出品/メッセージ送受信APIの存在を確認できなかったため）。lib/messaging/yahoo/adapter.tsのファイル冒頭コメント参照。",
  );
}

export async function sendYahooAuctionReply(orderId: string, body: string): Promise<never> {
  throw new Error(
    `Yahoo!オークションストア(注文${orderId})への返信送信は未実装です（一般提供されている送信APIの存在を確認できなかったため、本文「${body.slice(0, 20)}...」は送信されていません）。lib/messaging/yahoo/adapter.tsのファイル冒頭コメント参照。`,
  );
}

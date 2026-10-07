# 下書き読取通信の最小メタデータ観測案（2026-10-08）

この案は、本人が通常ログインしたShops専用ブラウザーで、下書き一覧または既存下書きの詳細を**読取操作**するときだけ使う受動的な観測器である。`draftReadMetadataObserver.mjs` は通信を再送・改変せず、ページ遷移、フォーム入力、保存、公開、新規作成も行わない。既存のPCアプリと出品前判定にはまだ接続していない。

## 取得する情報

対象は `https://mercari-shops.com/graphql` の `fetch` / `xhr`、POSTで、対象ページが正確な `?tab=draft` または `?productDraftId=...` のときに送られた、本文のGraphQL定義が明示的な単一の `query` である通信だけ。メモリ内で本文を解析し、結果には次の情報だけを残す。

- 一覧か詳細かの種別、GraphQL `operationName`、HTTPステータス
- JSON応答のフィールド名・型・配列かどうか（深さと件数に上限あり）、GraphQLエラーの有無
- 観測件数の上限超過状態、および常に `allowFinalCreate: false`

Cookie、認証ヘッダー、URLの下書きID、GraphQL変数値、商品の値、通信本文、エラーメッセージ、アクセストークンは保存・返却・表示しない。観測器はファイルも作らない。応答が大きすぎる、JSONでない、通信が失敗した場合は構造を未確認とする。匿名query、mutation、subscription、対象外ページは採用しない。

## 読取証明の限界

operationNameと応答構造だけでは、特定の下書きIDと表示値の対応や全ページの列挙完了を証明できない。サービスワーカー経由など、Playwrightが観測できない通信もあり得る。観測0件を「通信なし」「重複なし」と解釈しない。実UI上で通常の一覧・詳細読取に対応するoperation名と応答構造を確認し、別途ID対応・読み込み完了の証拠を設計・レビューするまでは、下書きcollectorの結果を `detailVerified` に昇格せず、CREATEの最終送信を封鎖する。

参照: [Playwright BrowserContextのnetwork eventsとService Workerに関する注意](https://playwright.dev/docs/api/class-browsercontext)。

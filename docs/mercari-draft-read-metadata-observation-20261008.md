# 下書き読取通信の最小メタデータ観測案（2026-10-08）

この案は、本人が通常ログインしたShops専用ブラウザーで、下書き一覧または既存下書きの詳細を**読取操作**するときだけ使う受動的な観測器である。`draftReadMetadataObserver.mjs` は通信を再送・改変せず、ページ遷移、フォーム入力、保存、公開、新規作成も行わない。既存のPCアプリと出品前判定にはまだ接続していない。

## 取得する情報

対象は `https://mercari-shops.com/graphql` の `fetch` / `xhr`、POSTで、対象ページが正確な `?tab=draft` または `?productDraftId=...` のときに送られた、本文のGraphQL定義が明示的な単一の `query` である通信だけ。メモリ内で本文を解析し、結果には次の情報だけを残す。

- 一覧か詳細かの種別、固定値 `NAMED_QUERY`、HTTPステータス。GraphQL `operationName` は本文内でqueryを検証した直後に破棄し、返さない
- JSON応答の型・フィールド数・型別件数・配列かどうか（上限あり）、GraphQLエラーの有無。応答のキー名は返さない
- 観測件数の上限超過状態、および常に `allowFinalCreate: false`

Cookie、認証ヘッダー、URLの下書きID、GraphQLの生のoperationName、変数値、商品の値、応答のキー名や別名、通信本文、エラーメッセージ、アクセストークンは保存・返却・表示しない。観測器はファイルも作らない。応答が大きすぎる、JSONでない、通信が失敗した場合は構造を未確認とする。匿名query、mutation、subscription、対象外ページは採用しない。

## 読取証明の限界

匿名化したquery種別と応答構造だけでは、特定の下書きIDと表示値の対応や全ページの列挙完了を証明できない。サービスワーカー経由など、Playwrightが観測できない通信もあり得る。観測0件を「通信なし」「重複なし」と解釈しない。実UI上で通常の一覧・詳細読取に対応するoperation名を別の安全な方法で確認し、別途ID対応・読み込み完了の証拠を設計・レビューするまでは、下書きcollectorの結果を `detailVerified` に昇格せず、CREATEの最終送信を封鎖する。

参照: [Playwright BrowserContextのnetwork eventsとService Workerに関する注意](https://playwright.dev/docs/api/class-browsercontext)。

## 一回限りの実行入口（レビュー候補）

`draftReadMetadataCli.mjs` は、明示的な `--confirm-readonly-draft-metadata` がある場合だけ、PCの既存設定・単一店舗の紐付けを読み取り、Shops専用Chromeの新規タブを開く。ショップIDや下書きIDを引数・標準出力へ出さない。本人が通常ログインした既存の専用プロファイルだけを使い、プロファイルが未作成、Service Workerが残る、空白以外のタブが復元された場合は中止する。下書き一覧の現在観測済み件数12行を三度照合したあと、行内に操作要素がない場合だけ先頭の**既存下書き**を一度開く。商品名・管理コードなどの値は出力しない。

専用セッションはService Workerを遮断し、新規タブのWebSocketをサーバーへ接続しない。HTTPはGET/HEAD/OPTIONSと、本文が明示的な単一GraphQL queryであるPOSTだけを通し、それ以外を中断する。通ったqueryでもリクエスト本文・応答本文・operationName・応答キー名を記録しない。終了時に観測listenerを外し、専用ブラウザーを閉じる。画面件数が一時的に13行になる、認証が切れている、詳細に遷移しない、通信が捕まらない、終了処理を確認できない場合は、それぞれ固定の未確認状態にする。結果は常に `allowFinalCreate: false`。

この入口はまだPC設置版にもBELLO画面にも接続しておらず、実ブラウザーでは未実行。独立レビューが終わるまで使用しない。読取通信を観測できても、下書きの不存在や新規出品の安全性を証明したことにはならない。

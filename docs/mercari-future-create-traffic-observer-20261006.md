# 次の未出品商品向け通信観測候補（2026-10-06）

今回の候補は**通信の観測だけ**であり、商品を入力・保存・作成・公開しない。実サイトでは起動していない。本人が次の未出品BELLO在庫IDとテスト価格を指定し、BELLO保存済み下書きから `PREPARED_NO_SEND` を作った後に限り、専用PC経路 `observe-future-private-create-traffic` が利用できる。B005757/B005795は在庫ID・管理コードの大文字小文字を変えても対象にできない。

専用Chromeを開く前に固定店舗で一回限りのclaimを排他保存する。Shopsの新規画面は明示的な保存ボタンを押さずに `productDraftId` を生じたため、ページ遷移前のclaimを必須にした。再起動・認証切れ・ブラウザ終了・結果不明でも同一店舗のclaimを自動で解除・再利用しない。以前の[帰属不明の空下書き](mercari-private-create-ui-observation-20261006.md)は商品IDとみなさず、次の対象に流用しない。復元されたブラウザに新規商品フォームや既存商品の編集フォームがあれば停止し、そのタブを遷移させない。通常時も新しいタブを使う。

観測器は固定店舗の商品一覧・新規画面から発生するShops宛ての `fetch` / `xhr` の `POST` / `PUT` / `PATCH` だけを受ける。記録は送信先の正規化host/path、要求順、method、許可済みJSONキーの順序、HTTP status、`createProduct.product` 応答で確認できた場合の結果ID/状態、URLに現れた `productDraftId` の `UNKNOWN_UNATTRIBUTED` 状態に限る。path中の識別子とqueryは隠す。本文の値、GraphQL文字列、Cookie、Authorization、CSRF、画像バイト、他ドメイン、ログイン画面の通信、未承認JSONキー、例外本文は保存・表示しない。イベント数・JSONキー数・JSON本文サイズ（128KiB）が上限を超えた観測は `TRUNCATED` とする。

結果ファイルは常に `OBSERVED_UNVERIFIED` / `listingConfirmed:false`。結果IDが見えても商品への写真関連付け、非公開状態の別読込、BELLOとの紐付けを証明しない。観測したリモート下書きIDは確定商品IDとして扱わない。今後の送信機能・ID受理経路は、この観測結果の独立レビューと正確な契約確定後に別途実装する。

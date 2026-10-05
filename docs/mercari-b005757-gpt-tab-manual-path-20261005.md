# B005757 非公開テスト登録: GPT内タブ経路（2026-10-05）

## 現在の境界

本人が指定した対象は、店舗 `evkhihBFFNn5hukMS9s36H` の BELLO 在庫 `B005757`、新しい管理コード `B005757-TEST-20261004-caf445ac6e676343`、価格98,000円の新規商品1件である。通常画面から**非公開**で保存し、公開は別判断とする。既存公開商品 `2JXdS6R5NNQPJadMexKmTr` を編集しない。商品名・説明・画像・カテゴリ・状態・配送の確認元と未確認事項は [従来の準備記録](./mercari-b005757-private-create-preparation-20261004.md)を参照する。

GPT内タブの正規Shops画面は通常UIとして操作できるが、このタブのネットワーク要求を既存PC観測器へ渡す手段はない。専用Chromeのセッションとも共有されない。そのため、GPT内タブでの保存操作と画面の表示だけでは `createProduct` の要求・応答、商品ID、非公開状態、画像の保存をHTTPレベルで認定しない。直接HTTP方式による新規作成も未実証である。

## 一回限りの試行手順

1. 正規Shops画面で、今回の**完全な**新規管理コードについて、見える出品中・下書きの範囲を再確認する。検索欄が管理コードを対象にするかは未確認なので、検索0件を全件不在の証明にしない。BELLO画像と参照商品の説明・カテゴリ・状態・配送も確認する。一致・不明なら作成へ進まない。
2. PCローカルQueueの `readCreateTestPreflight` が `LOCAL_ATTEMPTS_CLEAR` で、`readCreateTestClaim` が未請求であることを確認する。2026-10-05の確認時は前者がclear、既知の記録3件、後者は未請求だった。以後は都度再確認する。
3. **画像の選択やShopsの保存操作より前に** `claimCreateTestOnce` で店舗単位の永続マーカーを排他作成する。失敗・認証切れ・操作中断でもマーカーを解除せず、同じSKUの新規作成を再試行しない。候補CLIの `claim-private-create-once` はこの既存関数を呼ぶだけで、ChromeもShops通信も開始しない。実マーカーはまだ作成していない。
4. GPT内タブで固定対象の商品名・管理コード・98,000円・画像・説明・カテゴリ・状態・数量・配送・非公開を画面で確認する。非公開保存を行うなら**1回だけ**押す。未確認の値を推測して埋めない。保存前後の画面と、新しい商品IDが見えた場合の正確なIDを記録する。
5. 通信を観測できなかった場合、候補の `recordCreateTestUiAttemptUnverified` で同じ試行IDに結果 `UNVERIFIED / NETWORK_NOT_OBSERVED` を1回だけ保存する。この結果は商品作成・非公開保存・出品完了の成功を示さず、再送許可にもならない。結果不明でも対象SKUと見えたIDを読み取りで照合し、新規作成を繰り返さない。

## BELLOへの保存に必要な境界

既存の `MercariBridgeReadJob/ReadResult` は**既存商品読取専用**であり、`ChannelListing` は出品状態として扱われるため、新規作成の試行記録を流用しない。候補コードには、管理者と対象在庫を確認したうえで、固定店舗・SKUの試行キーを条件付きで一度だけ保存する `MercariBridgePrivateCreateEvent` と、同じ試行IDに紐付く `UI_ATTEMPT_UNVERIFIED / NETWORK_NOT_OBSERVED` の別イベントを追加した。ローカルclaimと結果は固定項目だけのJSONへ書き出し、GPT内のBELLO設定画面から取り込む。結果にはHTTP成功・商品ID確定・公開成功の属性を含めない。BELLO上のclaim保存が完了するまで通常UIの保存操作へ進まない。

このBELLO経路は2026-10-06に検証環境へ反映され、`MERCARI_PRIVATE_CREATE_TRIAL_ENABLED=1` と正確な検証環境の `MERCARI_BRIDGE_PUBLIC_ORIGIN` を揃えて有効にした。BELLOへのclaim保存・再読込まで確認済みである。Shopsでは入力中に予期しない下書き保存表示が生じたため追加書込を停止し、明示の非公開保存や画像選択は行っていない。以下にその観測と結果記録の境界を追記する。

## 2026-10-06 入力中の下書き保存表示

検証環境でBELLOの一回限りのclaimを保存・再読込した。同一試行IDは `6e8efef2-4836-4d11-9b98-a885fe24c3ce`。Shops新規フォームへの商品名・説明・SKU・価格の入力中、明示の保存ボタンや画像選択を行う前に「下書きに保存しました」が3回表示された。読取専用で下書き一覧を照合すると、本日作成された同名の3件が増えていた。`2JXjT6f2dfWMqhhNwJqizt` と `2JXjT6ea2LkmGV5YdPKRJQ` には固定SKUが見え、`2JXjT6eEPuYNg52GsxUN4a` のSKUは空欄だった。3件とも商品名・説明1524字があり、価格0円・画像0枚・カテゴリ未選択の下書きである。BELLOへの試行結果ファイルに下書きIDや商品内容は含めない。HTTP通信と下書き保存の原因は未観測で、非公開登録の完成も未確認である。価格欄は一度98,000円を表示した後に0円へ戻った。

明示保存クリックが無いので `record-private-create-ui-unverified --confirm-click yes` は使わなかった。`record-private-create-draft-autosave-unverified --confirm-autosave yes` を保存済み試行IDに対して一度だけ実行し、ローカル結果 `UNVERIFIED / DRAFT_AUTOSAVE_UI_OBSERVED` を記録した。BELLO取込用ファイルは `C:\Users\win\Documents\BELLO-B005757-private-create-ui-result-20261006.json` に書き出し、BELLOに一度だけ取り込んで再読込を確認した。これは入力中の下書き保存表示を報告する元の試行結果であり、後の非公開保存の成功記録には変更しない。同じSKUの新規作成を再試行しない。

ローカル入力イベント画面では、商品名欄へのCUA `setValue` 1回は `input=1/change=1/Enter=0/submit=0`、Playwright `fill` 1回は `input=1/change=0/Enter=0/submit=0` だった。`focusout=1` はリセットボタン由来の可能性がある。これはローカルフォームの差であり、Shopsの下書き保存が`change`で起きた証明ではない。追加のShops新規フォーム操作は行わず、既存下書きの読取結果で照合する。

## 2026-10-06 既存下書き1件の非公開保存とBELLO紐付け

上記の下書き `2JXjT6f2dfWMqhhNwJqizt` だけを通常画面で補完した。BELLOに登録済みの画像1枚、カテゴリ、状態、配送、数量1、98,000円、固定SKUを確認し、「非公開で保存する」を1回押した。Shops一覧に現れた商品IDは `2JXjWPRVBxjZ2K2vgTGNqy`。一覧では「非公開」・98,000円・在庫1、編集画面の再読込では画像1枚、固定SKU、カテゴリ、状態、配送、価格を確認した。証拠は `C:\Users\win\Documents\Codex\2026-10-04\bello-b005757-private-list-accepted-20261006.jpg` と `C:\Users\win\Documents\Codex\2026-10-04\bello-b005757-private-edit-accepted-20261006.jpg`。これは**Shops通常画面の再読込で確認した非公開商品**であり、新規作成のHTTP要求・応答、直接HTTP作成、公開出品の証明ではない。元の `UI_ATTEMPT_UNVERIFIED` 記録はそのまま保持する。残る下書き `2JXjT6ea2LkmGV5YdPKRJQ` と `2JXjT6eEPuYNg52GsxUN4a` は触らない。

BELLOにこの商品IDを紐付ける既存経路は、管理者用の「既存商品だけを照合する」画面で在庫ID `c9ee4ea7-070f-491c-bd4c-c1547cb73436`、店舗ID、商品IDを2回入力し、画面確認のチェックを入れて依頼する操作である。`reserveExistingReadRequest` は `MercariBridgeBinding` を在庫ID主キーで条件付き作成し、既存の異なる商品IDを上書きせず `BINDING_CONFLICT` にする。同時に `MercariBridgeReadJob` を作るが、結果の `CONNECTOR_NOT_CONFIGURED` は読取未実施を意味する。Shopsへ書込・新規作成・公開・在庫変更は送らず、`ChannelListing` も変更しない。保存後は同じ管理者で依頼IDを確認し、紐付けの店舗・商品IDを保存データから再確認する。既に別の紐付けがある場合は上書きせず停止する。

今回のShops商品管理コードはテスト用接尾辞付きで、BELLO在庫コード `B005757` と文字列が異なる。既存読取依頼のスナップショットは在庫コード `B005757` を比較値にするので、将来の読取でこの項目は差異として扱う。紐付け保存だけを商品一致や自動出品の成功に格上げしない。

### BELLOでの保存受入（2026-10-06）

最初の紐付け操作は「保存済みの商品と下書きが必要です」で停止した。続くEC下書きの最初の保存は結果不明表示となったが、検証環境ログには旧・新デプロイ間のServer Action識別子不一致があり、読取時点の対象下書きは0件だった。画面の再読込後、同じ画面内容からEC下書きを1回保存し、「保存しました」の表示と再読込後の下書き操作が確認された。読取専用のDB照合では対象在庫の下書きは1件（`e339b6b4-eb97-4294-b96c-fa7192e31224`）、価格0円、説明未登録、選択画像1件だった。これは共通EC下書きであり、Shopsの非公開商品に表示された98,000円・説明文とは別の値である。証拠ファイルは `C:\Users\win\Documents\Codex\2026-10-04\bello-b005757-ec-draft-saved-20261006.jpg`。

その後、既存の読取依頼画面で店舗 `evkhihBFFNn5hukMS9s36H` と非公開商品 `2JXjWPRVBxjZ2K2vgTGNqy` を選び、画面は「読取依頼は記録しました。Shopsの照合結果はまだ届いていません。」と依頼ID `7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825` を表示した。読取専用のDB照合でも、`MercariBridgeBinding` はこの在庫・店舗・商品IDと `USER_REVIEWED_UI` に一致し、同じ依頼IDの `MercariBridgeReadJob` は `READ_EXISTING / CONNECTOR_NOT_CONFIGURED` だった。証拠ファイルは `C:\Users\win\Documents\Codex\2026-10-04\bello-b005757-binding-accepted-20261006.jpg`。この時点でBELLOの紐付けは保存済みだが、ShopsへのPC読取・直接HTTP読取はまだ実行も報告もされていない。下書き保存と紐付けはShopsへの追加書込を発生させない。元の一回限りの試行結果は `UNVERIFIED` のまま維持する。

次工程は、固定した依頼IDの読み取り専用照合で、同じ店舗・商品ID、非公開状態、価格、SKUなどを**読取結果として別に保存**すること。現在のPC通常画面読取は依頼に対して動的な商品IDを使えるが、直接HTTP読取の一回限りの証明・取込はB005795の旧商品IDに固定されている。B005757へその証拠を流用しない。まず新商品の通常画面読取とその通信候補を同じPC認証状態で観測し、要求・応答の一致と読取専用性を確認する。直接HTTP読取へ進める場合は、対象固定・一回限りの試行記録・結果取込の拡張を個別レビューしてから行う。新規作成・公開・在庫変更・残る下書き2件の操作は行わない。

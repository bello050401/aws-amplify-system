# BELLO × メルカリShops PC連携: 設置前点検と停止・再出品の受入手順（2026-10-07）

## 現在の判定

この文書は**実行手順の準備**であり、PC設置版の更新、Shopsへの保存、公開・停止・再出品、Amplify配信を許可しない。候補コードの独立再レビューが合格するまで以下の「反映」は実行しない。B005659（在庫ID `dd273c1e-9b2a-4013-acc6-c445a481fab8`）は **99,999円の非公開限定テスト**で、停止・再出品の対象外。既存公開商品 `2JWp7EJx6aqKfn6dTXc5Q9` も変更しない。

候補は `927d267` 時点の作業ブランチ。停止・再出品の核は `ee11737`（状態判定）、`8c317c5`（PCの一回限りの実行）、`e33e65e`（BELLOの依頼作成）、`44876ac`（PC受信と結果読取）。`f788054` はB005659の大文字・配列IDによる保護回避を塞ぎ、`c13c50f` は停止確認後の一覧への戻り口を追加した。`df7e635` は通信観測20件上限での誤成功と、別在庫・別試行のPC結果を誤表示する問題を塞ぎ、`927d267` は結果不明への遷移を回帰テストで固定した。レビューは**このコード一式と設置差分**に対して行う。

2026-10-07の読取点検では、設置済み `App/src` は38ファイル、別フォルダー `AppPrivateCreateCandidate-20261007/src` は43ファイル。別フォルダーは**旧候補 `c13c50f` 時点のコピー**で、`df7e635` の修正前なので設置元にしない。PCアプリのNodeプロセス0、専用Chromeプロセス0、`127.0.0.1:56210` 待受けなし、`Queue/locks` 0件。現行設定は `createTestObservationEnabled=false` だが旧商品の `manualObservation` と `imageProof` があり、その操作ボタンも表示され得るため受入で押さない。これらは反映時にも改めて確認する。

## レビュー合格後の安全な反映

1. 対象コードのコミットIDとレビュー結果を固定する。BELLOの環境フラグ `NEXT_PUBLIC_MERCARI_VISIBILITY_PC_JOB_ENABLED` はこの時点でまだ `1` にしない。Shopsの専用Chrome、BELLO専用Chrome、PC操作画面に作業中の処理がないことを画面で確認する。
2. PC操作画面が開いていれば「終了」で通常終了する。結果不明のShops画面が残る場合は操作内容を記録し、画面を閉じてよいことが確認できるまで反映を止める。プロセスの強制終了や再クリックで収束させない。`desktopApp.mjs` のNodeプロセス0、両専用Chromeプロセス0、ポート56210閉鎖、`Queue/locks` 0件を再確認する。
3. `C:\Users\win\AppData\Local\BELLO\MercariBridge` の下に日時付きの新しいバックアップフォルダーを作る。既存 `App/src`、`App/package.json`、`App/package-lock.json`、`App/BELLOメルカリ照合.cmd`、`config.json`、デスクトップのショートカットを**コピー**して保全し、元ファイルのハッシュとコピーのハッシュを照合する。`Queue`（一回限りのclaimと結果を含む）、`ShopsChrome`、`BELLOChrome`、`PrivateTestAssets` は移動・削除・初期化せず元のパスに残す。これらのパスと件数を反映前後で記録し、設定の秘密値やブラウザー内の認証情報は報告へ出さない。
4. 再レビューが合格した固定コミットの `tools/bello-mercari-bridge/Install-BelloMercariDesktop.ps1` を既存のBELLO検証環境URLと**現行の**読取依頼IDで実行する。インストーラーは別依頼ID・別URL・稼働中PCアプリを拒む。現行 `config.json` の値を読み取り、`requestId` を推測して書き換えない。実行前にインストーラーが候補43ファイルと `package*.json` を配置する差分をレビュー結果に照らして確認する。旧別フォルダーを設置元にしない。
5. 反映後、設置版 `App/src` の全候補ファイルのSHA-256が固定コミットと一致すること、`config.json` の既存キー・値、Queue/claim/結果件数、両Chromeプロフィールの元パスが維持されたことを確認する。`node --check` で追加・変更した `.mjs` を検査する。PCアプリを起動しても、**表示とローカル受信の確認だけ**とし、Shopsを変更するボタンは押さない。
6. 反映または起動に失敗した場合は処理を止め、PCアプリが終了していることを確認してからバックアップの `App` ファイルと `config.json` だけを元のパスへコピーで戻す。Queue、claim、結果、Chromeプロフィールは巻き戻さない。失敗後のShops操作は再試行しない。

## 候補で通過したローカル検査

| 境界 | 対象 | 2026-10-07結果 |
| --- | --- | --- |
| BELLO依頼作成 | `lib/listing/mercariBridge/visibilityHandoff.test.mjs` | 2/2通過。管理者の保存済みデータから作る依頼がPCの厳密検証を通り、B005659・保護済み公開ID・古い記録は拒否される。 |
| PC受信・保存済み結果 | `desktopApp.test.mjs`, `visibilityJobInbox.test.mjs` | 対象を含む34/34通過。BELLO originからの受付は `QUEUED_NO_SEND`、別originは403、ファイル読込は送信しない。保存済み結果は在庫ID・店舗・商品ID・操作・対象指紋・試行ID・公開状態を照合する。 |
| 停止・再出品の判定と一回限り処理 | `visibilityTransitionPlan.test.mjs`, `visibilityTransitionOnce.test.mjs`, `manualMutationObservation.test.mjs` | 上記34件と通信観測の回帰試験を通過。事前・事後の同一商品読取、単一更新応答、停止証拠後の再出品、結果不明時の再実行遮断、B005659の大文字・配列ID拒否を検査。通信観測が20件に達したら、21件目を見落とし得るため成功と判定しない。 |
| PCツール全体 | `npm test`（`tools/bello-mercari-bridge`） | 207/207通過。実Shopsへの接続・保存は含まない。 |
| BELLO型検査 | `npm run typecheck`（リポジトリ直下） | 通過。 |

検査コマンドは、PC側が `node --test test/visibilityTransitionPlan.test.mjs test/visibilityTransitionOnce.test.mjs test/visibilityJobInbox.test.mjs test/desktopApp.test.mjs`（34/34）と `node --test test/manualMutationObservation.test.mjs`、BELLO側が `node --experimental-strip-types --test lib/listing/mercariBridge/visibilityHandoff.test.mjs`（2/2）。後者のNodeモジュール形式の警告は結果に影響しなかった。

## 実際の公開可能商品ができた後の受入

この受入はB005659には適用しない。別の公開可能商品について、本人が店舗・BELLO在庫ID・Shops商品ID・SKU・価格・数量を指定し、BELLOの保存済み `ChannelListing` が同じIDで `ACTIVE`、下書きも同じ在庫に属することを確認してから始める。Shopsの新規作成や公開をこの手順で代行しない。

1. **送信なしの接続確認:** BELLOのEC出品画面で停止ジョブを作り、PC操作画面に同じ店舗・商品ID・SKU・価格・数量の依頼が1件だけ現れることを確認する。PC未起動時はJSONファイル保存とPC側の明示読込を確認する。ここまではShopsの商品状態が変わらず、claimも作られない。
2. **停止の一回限り操作:** PC画面で対象を再確認して停止を1回実行する。実行器はclaimを先に残し、Shops一覧で同じ公開商品IDを確認し、通常画面の「非公開で保存する」を1回だけ押す。同一商品の更新応答と別画面の非公開読戻しが揃った場合だけ `STOP_VERIFIED`。不明なら `UNKNOWN` として再クリックできない。
3. **BELLOで結果確認:** EC画面の「PCの結果を確認」で同一Shops商品IDの保存済み結果を読む。`STOP_VERIFIED` の場合だけ「停止確認済み」と「EC出品一覧に戻る」を表示する。PCが閉じている、ID不一致、結果不明のときは完了と扱わない。この段階の結果はPCローカルにあり、BELLOの `ChannelListing` を自動更新しない。
4. **再出品の一回限り操作:** 停止結果と現在の非公開読戻しを保持する**同じ商品**に限り、BELLOから再出品ジョブを作る。PC画面で対象を再確認して1回だけ実行し、同一商品の公開更新応答と別画面の公開読戻しが揃った場合だけ `RELIST_VERIFIED`。結果不明なら再クリックしない。
5. **終了確認:** BELLOのPC結果表示とShops通常画面の同じ商品ID・公開状態を突き合わせる。Queueのclaim・結果は消さず、停止と再出品の試行ID、時刻、対象IDを記録する。B005659と既存公開商品 `2JWp7EJx6aqKfn6dTXc5Q9` の商品状態が変わっていないことも確認する。

現在はこの実サイト受入を実施していない。BELLOの機能フラグは既定でオフ。PCローカル結果をBELLOクラウドの正式な出品状態へ取り込む経路も未実装のため、PC読取表示を販売・在庫連動の完成証明にしない。

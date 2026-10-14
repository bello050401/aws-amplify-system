# HTTPS認証更新・商品条件対応（2026-10-14）

## 根拠

- 本人提供HARの 2026-10-14 13:50:13 UTC に、`POST https://mercari-shops.com/auth/token/refresh`、本文なし、HTTP 200 を確認。
- 認証用Cookieは `refresh_token`（`/auth/token/refresh`）、`device_id` / `device_token`（`/auth`）。応答は `id_token`（Max-Age 3600）と更新済み `refresh_token`（Max-Age 7776000）。秘密値はこの文書・Gitに記載しない。
- 後続の認証済み管理画面の通信と対応する更新後Cookieを取り込む。更新前のrefresh tokenを保存し直さない。
- 保存済み2026-10-09 HARの状態マスターから、NEW / LIKE_NEW / NO_NOTABLE_DAMAGE / SLIGHT_DAMAGE / DAMAGE / BAD の6組を日本語ラベルで確認。
- 同HAR内の画面チャンク `59617-2370504a4922def5.js` で下書きのブランド指定は `[brandId]`、未指定はnull、公開は配列であることを確認。ブランド名・IDは既存の選択用マスターと照合する。

## 実装

- 利用時に残り10分以下ならサーバーがHTTPSで認証を更新する。期限が過ぎたID Cookieでも、更新用Cookieが有効なら更新可能。ブラウザやPC常駐アプリを使用しない。
- 更新はDynamoDBで認証世代ごとに1回だけ確保する。応答不明時の再送を防ぎ、Self・店舗・同一主体を確認してからSecrets Managerに保存する。
- 一時版の保存後、旧版を明示してAWSCURRENTを移動する。途中で新しい認証が取り込まれた場合は古い更新結果で上書きしない。[AWS仕様](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecretVersionStage.html)。
- 秘密は既存の専用Secretのみ。商品APIへ更新用Cookieを送らない。リダイレクト、追加認証、結果不明、店舗不一致は停止する。
- 90日は今回の応答で観測した更新Cookieの期限であり、再ログイン不要期間の保証ではない。更新後の期限と端末Cookieの実際の期限に従う。
- EC画面の接続更新から商品を変更せず更新を確認できる。商品状態と任意ブランドは下書き保存、再読込、公開前照合まで一致を要求する。

## 検証

自動テストでCookieの更新・パス分離・同一主体・店舗確認、期限前/期限後の更新、同時実行、応答不明時の再送禁止、新しい認証の優先、HARの更新後Cookie選択を検証。商品状態6種・任意ブランド・不一致時停止も検証。

検証環境での反映と実通信の確認結果は、この文書に追記する。

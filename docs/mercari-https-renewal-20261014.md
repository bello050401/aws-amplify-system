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

## 検証環境の反映・実通信 — 完了

- コード `39b68ddf09b5adc326a6ee00c9cf0d1feab10cd3` を承認済みAmplify検証環境へ反映。job 424 のBUILD / DEPLOY / VERIFYはすべてSUCCEED。
- 関連テスト92件、TypeScript検査、差分形式検査を通過。テスト対象は商品状態・ブランド照合、下書き送信・読戻し、公開・停止・再出品、認証更新・競合処理。
- 2026-10-14 14:12:08 UTC、配信済みBELLO EC画面の「接続を更新」から、AWSサーバーが通常のHTTPSリフレッシュを実行。商品操作・ブラウザー認証操作は行っていない。
- 画面に「接続を確認しました。商品は変更していません。」と表示。Secrets Managerの現行版が切り替わり、認証期限は14:50:16 UTCから15:12:07 UTCへ延長された。
- 更新用Cookieも新しい値に置き換わり、その有効期限は2027-01-12 13:50:13 UTCから同日14:12:07 UTCへ延長された。次回更新に必要な材料が保存されていることを、値を出力せず確認した。
- 画面を再読み込みしても、保存された新しい認証で状態取得に成功。B005105の商品 `2JY9REopKfLdpCfQKvU4yf` は「出品停止中」、表示期限は2026/10/15 0:12:07 JST。公開操作は繰り返していない。
- 秘密を含まない比較記録: `C:/Users/win/Documents/Codex/2026-10-14/mercari-https-proof/auth-before-renewal.json` と `auth-after-renewal.json`。最終画面: 同ディレクトリの `bello-renewed.png`。

## 完了範囲と運用上の境界

承認済み検証環境のBELLO EC画面から、画像登録・下書き保存、公開→停止→同一商品再出品→停止、結果保存、認証更新までサーバーHTTPSで実証済み。公開操作の詳細は `mercari-https-live-draft-20261014.md` を参照。

実商品での一貫試験はB005105（CONDITION_CLEAN、ブランド未指定、99,999円、数量1）。他の状態6種の対応とブランド照合は観測仕様に基づく自動テストで検証しており、全組合せの実商品送信を実施したとは扱わない。自動更新の期限判定はテスト済み、今回の実通信は画面からの明示更新で確認した。90日間連続運用や再ログイン不要を保証するものではなく、先方が認証失効・追加確認を要求した場合は停止し再認証を案内する。

本番環境への変更は行っていない。BASE維持、Next Engine開発の再開なし。定期実行 `bello-2` は本人指示どおりPAUSEDのまま。

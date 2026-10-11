# メルカリShops通常ログインHARの非秘密構造（2026-10-11）

本人提供のローカルHARを端末上だけで解析した。HAR原本、パスワード、認証コード、Cookie、トークン、個人識別子、要求・応答本文はGit・チャット・通常ログへ保存しない。以下の番号は**Mercari系HTTPS通信だけを数えた順序**。要約対象は151件で、先頭1,000件の制限による切り詰めはない。公開JavaScriptからの[仮説](mercari-http-only-login-static-hypotheses-20261009.md)と異なり、下表はこのHARに存在した通信の構造である。ただしHAR自体はBELLOサーバーからのHTTP成功証拠ではない。

| 順序 | HARに記録された非秘密の事実 | 解釈の限界 |
| --- | --- | --- |
| 40〜79 | `GET https://auth.mercari.com/:redacted/v1/authorize` はHTTP 302。クエリ**項目名**に `client_id`、`code_challenge`、`code_challenge_method`、`redirect_uri`、`response_type`、`scope`、`state` 等がある。その後、Mercari系ホストの `/.../v1/challenge/...` などへの複数のPOSTがHTTP 200。59番の要求**項目名**には `gRecaptchaResponse`、`challengeId` に関わる別要求もある。 | 認可値・チャレンジ値は見ていない。SMS入力の成否や各200応答の認証成功は、これだけでは確定しない。bot対策やチャレンジを回避・再送しない。 |
| 80 | `GET https://mercari-shops.com/signin/seller` がHTTP 200。 | 画面取得だけではログイン成功を示さない。 |
| 127 | `POST https://mercari-shops.com/auth/signin/idp` がHTTP 200。要求はフォーム形式で、**項目名**は `idToken` と `refreshToken`。応答Content-Typeは `text/plain`。 | トークン値と応答本文は出力せず、再利用しない。HTTP 200だけでは、BELLOサーバーのセッション成立条件は分からない。 |
| 129 | `POST https://mercari-shops.com/graphql` の名前付き `Self` queryがHTTP 200。応答JSONに `data.self` が存在する。 | ログイン中の取得元環境での認証済み読取を示すが、BELLOサーバーへ認証を移せる証拠ではない。 |
| 130 | 同じGraphQLへの `OwnShops` queryがHTTP 200で、応答JSONに `data.ownShops` が存在する。後続にも店舗画面の読取queryがある。 | 対象店舗の本人権限・下書き一致・出品可否を、この要約だけで判定しない。 |

これらのHAR記録では、要求の `Cookie`、`Authorization`、CSRFヘッダー、応答の `Set-Cookie`、HARのCookie配列はいずれも**記録上0件**だった。実通信で不要だったとは断定しない。公開コードは認証呼出しに `credentials: include` を使うため、HARの欠落・エクスポート方式・ブラウザー管理状態を区別する必要がある。セッションの保存形式、期限、更新条件は依然として未確認。公開コードにある `/auth/token/refresh` の実通信もこのHARには見つからなかった。

既存の[B005396下書きHAR](mercari-b005396-http-draft-har-evidence-20261009.md)は別のログイン済み商品操作を示す。この新HARでは `Self` と `OwnShops` の読取は確認できたが、同一認証状態を使った `GetProductDraft`、BELLOサーバーからの読取、画像アップロード、新規作成・公開は確認していない。B005396には下書きが既に2件あるため新規作成を許可しない。

次に必要なのは、提供元が許すHTTP専用ログイン方式・bot対策を含む仕様と、本人の通常ログイン中に**値を保存せず**確認したCookie/Set-Cookie/CSRFの存在・期限属性、自然なセッション更新の通信構造である。現HAR内のトークンやチャレンジ値を使った再送はしない。これらが確定するまで認証HTTPアダプターも実出品器も接続しない。

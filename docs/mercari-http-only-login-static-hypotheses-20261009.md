# メルカリShops通常ログインの公開コード調査（2026-10-09）

## 観察した範囲

未認証で[公開ログインページ](https://mercari-shops.com/signin/seller)をGETし、HTMLが直接参照するNext.jsの公開JavaScriptをGETした。ページのビルドIDは `HGSe3iGyD2X85Zg3SkcfH`。認証情報入力、ログイン、SMS送信、GraphQL/認証APIへの試行、Cookie取得、bot対策への操作はしていない。以下は**公開コードから読める分岐と候補**であり、この店舗の実通信やHTTP専用ログインの成功証拠ではない。

参照した主要ファイルは [`signin/seller`ページ](https://mercari-shops.com/_next/static/chunks/pages/signin/seller-e694ac24ffa54927.js)、[ログイン分岐チャンク](https://mercari-shops.com/_next/static/chunks/72646-ebeb5d7dc4fa02ac.js)、[共通アプリチャンク](https://mercari-shops.com/_next/static/chunks/pages/_app-f6363a86c5fcba20.js)、[認証ライブラリチャンク](https://mercari-shops.com/_next/static/chunks/faec1f96-5f2088af0449b370.js)。ファイル名はビルド更新で変わり得る。

## 公開コードから分かる仮説

| 段階 | 静的コードにあるもの | まだ証明しないもの |
| --- | --- | --- |
| 開始 | ページはショップオーナー・スタッフなどのログイン入口を表示する。コードには `/signin/seller/basic` と、owner/staffの電話確認**画面ルート**がある。メール・パスワード分岐はFirebase認証関数を呼ぶ。 | どのアカウント種別・画面分岐を本人が使うか。画面ルートはAPI送信先を意味しない。 |
| SMS/追加認証 | `multiFactorResolver` の分岐、電話確認の開始とコード確認、`invisible` reCAPTCHAを使うコードがある。認証ライブラリには `identitytoolkit.googleapis.com`、`securetoken.googleapis.com`、`accounts:signInWithPassword`、`mfaSignIn:start`、`mfaSignIn:finalize` という文字列がある。 | これらのライブラリ内の候補が当該ログインで実行されるか、実際の順序・条件・要求本文・応答。reCAPTCHAの回避手段は検討しない。 |
| Shopsへの引渡し | Firebase利用者から得たID/更新トークンを、共通アプリの補助関数が `POST https://mercari-shops.com/auth/signin/idp` にフォーム形式で渡すコードがある。共通fetch補助関数は `credentials: include` を指定し、この呼出しは `no-cors` を指定する。 | この店舗でその経路が使われたか、応答・Cookie・CSRF条件・サーバー側の受理。トークン値は取得・記録していない。 |
| 更新と確認 | 共通アプリには `POST https://mercari-shops.com/auth/token/refresh` の `no-cors` 呼出しがあり、その後 `POST https://mercari-shops.com/graphql` で `Self` queryを送る分岐がある。共通fetch補助関数はHTTP 401を `UNAUTHENTICATED` に分類し、失敗時はサインイン画面へ戻す分岐を持つ。 | 更新がいつ走るか、HTTP専用クライアントで成立するか、Cookieの寿命。`Self` の存在は、実際の更新成功や商品読取成功ではない。 |
| CSRF | 上記2つの認証POST呼出しには明示的なCSRFヘッダー指定が見えない。公開HTMLにも `csrf` の文字列やフォームactionは見えなかった。 | CSRFが不要であること。Cookie、別モジュール、サーバー側、実通信の条件は未確認。 |

共通アプリには名前付き `query Self` があり、アカウント情報とトークン有効期間に関わるフィールドを要求する。この補助関数の送信本文には `query` が見えるが、別の `operationName` 項目は見えないため、実通信の同項目が `Self` として送られるとは断定しない。個人識別子の値は調べず、本文も保存しない。上表の順序はコード上の呼出し関係を簡略化したもの。メール確認済みか、電話登録済みか、追加認証が発生するか等で分岐するため、必ずこの順序で通信すると断定しない。

## 既存の実測とは別

[B005396 HAR要約](mercari-b005396-http-draft-har-evidence-20261009.md)は**ログイン済み**の商品下書き通信を確認したが、通常ログイン、SMS認証、トークン引渡し、セッション更新の実要求・応答は記録していない。[旧保存観測](mercari-private-save-live-analysis-20261004.md)で分かるのも商品通信にCookieが存在したことまで。従って、この公開コードのURLやFirebase候補を認証ポートの実送信契約へ昇格しない。

## 最小の追加観測

本人の通常ログインと必要なSMS確認を**1回だけ**受動的に観測し、上表の候補について、実際に使われたアカウント分岐、ホスト・パス・HTTP方法・順序・状態、リダイレクト、Cookie/Set-CookieとCSRFヘッダーの**有無だけ**、SMS段階の開始・完了・追加認証の状態を照合する。自然な更新通信が発生した場合だけ更新後の既知の読取を確認する。更新が発生しなければ未観測のままにし、期限やbot対策を操作して発生させない。原本を端末外へ出さず、パスワード、SMSコード、トークン、Cookie、個人識別子、要求・応答本文はチャット・Git・通常ログへ載せない。[ローカルHAR要約器](../scripts/summarize-mercari-login-har.mjs)は固定メタデータを抽出できるが、可変パスと未知のGraphQL操作名を伏せるため、これ単独でHTTPログイン契約は確定しない。

実測と提供元の許可・仕様が揃うまで、ログインHTTPアダプター、更新処理、出品処理は実装しない。

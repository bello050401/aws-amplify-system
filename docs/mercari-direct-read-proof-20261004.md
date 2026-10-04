# 既存商品の認証付きHTTP読取検証（2026-10-04）

## 実際に保存された読取証拠

本人がPC画面の「この読取依頼を照合する」を1回押し、BELLOはB005795の比較結果 `DIFFERENT` を受理した。PCの固定語彙の通信概要は `OBSERVED`、保存時刻は `2026-10-04T10:53:06.696Z`。通常のShops管理画面から次の1件が観測された。

| 項目 | 観測結果 |
| --- | --- |
| 操作 | `EditProductPage`、query型 |
| query SHA-256 | `307abc058c96db65d9be11acda8b5f40bf69e91be21579e1b4fb219e7e5e05bf` |
| 変数 | `id: string`、観測範囲の形は完備 |
| 対象 | 要求の商品ID一致、応答の商品IDと店舗ID一致 |
| 応答 | HTTP 200、GraphQL `errors` なし |
| 認証ヘッダーの存在 | Cookieあり、Authorizationなし、CSRFなし |

この記録に本文、変数値、Cookie・トークン値、個別URLの値はない。queryのSHA-256から本文を復元できないため、この保存記録だけで同じHTTP要求を構築できない。HTTP 200と一致判定は、通常のログイン済み管理画面の読取についての証拠であり、管理画面外からの直接HTTPや新規出品の証拠ではない。

## 次の1回限りの検証コード

候補版の `directReadProbeObserver.mjs` と `directReadProbe.mjs` は、B005795の既存商品と上記queryハッシュに固定する。本人が明示的にPC画面の「既存商品をHTTPで1回読取検証」を押した場合だけ、同じ専用Chrome内で対象商品の通常読取を開く。正確なqueryハッシュ、単一のquery操作、`id`変数、HTTP 200、エラーなし、応答の商品・店舗ID一致、JSON型の通信を確認できた場合に限り、**その場のメモリ内にある要求本文**を同じ `BrowserContext.request` で1回送る。Playwrightの[BrowserContext.request仕様](https://playwright.dev/docs/api/class-browsercontext#browser-context-request)では、このAPIは同じブラウザコンテキストのCookieを利用する。コードはCookie・トークン値を読み出したり保存したりしない。

直接HTTPの応答もHTTP状態、JSON型、GraphQLエラーなし、同じ商品・店舗IDで照合する。結果は固定コードとHTTP状態だけをPCローカルに保存する。実行前に一回限りの記録を作るため、通信結果が不明でも再送しない。画面上の既存商品は変更せず、画像追加・非公開保存・公開・新規商品作成は行わない。BELLOへの別の結果報告も行わない。

このコードは合成試験を通過した**候補**であり、設置版にはまだ反映せず、実際の直接HTTP要求もまだ行っていない。通常読取の形式が上記条件と違えば直接HTTP送信前に停止する。検証が成功しても証明できるのは、このPC上の専用ブラウザと同じ認証状態での既存商品の読取だけである。

## Web操作完結までの残る条件

[メルカリShops公式API仕様](https://api.mercari-shops.com/docs/index.html)は管理画面内の `/graphql` と別の `https://api.mercari-shops.com/v1/graphql` を公開し、Personal API Access Token、契約時のAPI_CLIENT_NAMEを含むUser-Agent、事前申請済みの日本国内の固定送信元IPを要求する。BELLO専用の資格情報と送信元IPは確認できていない。Next Engineに入力された資格情報をBELLOに流用しない。PC上で上記検証が成功してもBELLO Webサーバーからの直接HTTPが成立するとは判定しない。

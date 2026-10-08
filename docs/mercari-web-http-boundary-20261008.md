# BELLO WebからのメルカリShops出品: HTTP境界（2026-10-08）

## 実測と未実測

- 既存商品B005795の通常管理画面読取で得たGraphQL queryを、同じPCのログイン済みコンテキストから一度HTTP送信し、同じ商品・店舗の読取結果をHTTP 200で確認した。BELLO Webサーバーからの認証付き送信ではない。詳細は[認証付きHTTP読取検証](mercari-direct-read-proof-20261004.md)。
- 下書き一覧 `productDrafts` と詳細 `GetProductDraft` の `POST https://mercari-shops.com/graphql` 読取は、PCの管理画面で対象IDと要求・応答を照合した。作成履歴や新規作成の証明ではない。詳細は[下書き読取観測](mercari-draft-read-metadata-observation-20261008.md)。
- 既存画像操作では `createImageAsset` multipartのHTTP 200・GraphQLエラーなしを観測したが、要求形式、商品への紐付け、バイト同一性は未確認。新規出品のHTTP書込要求・応答契約は未観測。詳細は[最初の出品に向けた境界](mercari-first-listing-preflight-20261004.md)。

## 今回実装したWeb側の工程

B005396のBELLO保存済み下書き・選択項目をサーバーで再読取し、配送条件の確認後、商品ごとに一件の `MercariBridgeHttpDraftJob` を条件付きで記録する。内容とSHA-256指紋は固定し、同じ内容の再クリックは同じ依頼に収束させる。異なる内容は競合として停止する。状態は `AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT`。この操作はShopsへ通信せず、PCランタイムも起動しない。B005396のWeb画面からPCへの引渡しボタンは外した。既存のBASEとNext Engineの動作は変更していない。

EC出品画面では、既存のメルカリShops欄の直下にB005396用の「HTTP方式での出品」欄を置いた。「HTTP方式で出品を指示（準備登録）」は上記のWeb依頼だけを記録する。依頼状態はサーバーから再読取して表示し、Shopsの結果は「未送信（出品成立は未確認）」と明示する。その他の商品にある従来の準備欄の動作は変更していない。

## Webからの出品を完了する条件

公式API経路には、この店舗のBELLO用Personal API Access Token、API_CLIENT_NAME、承認済みの日本国内固定送信元IPが必要とされるが、利用可能な設定は未確認。通常の管理画面ログインやNext Engine用トークンはその代わりにならない。公式APIの `createProduct` 入力にはHTTPS画像URLが必要であり、BELLO保存画像をその方式で安全に渡す準備も要る。これらを確認し、読取実証・非公開作成・同じSKU/商品IDの読戻しをつないで初めてWeb出品を完了と判定する。内部の管理画面GraphQLを採る場合も、BELLOサーバーで使える認証と新規作成要求の正確な契約が別途必要。いずれも現時点では推測して送信しない。

# メルカリShops初回出品の検証境界（2026-10-04）

## 現在確認できた範囲

B005795の既存商品について、管理画面の通常読取と、同じPCの正規ログイン状態を利用した直接HTTP読取が `MATCHED / HTTP 200` になった。これは**読取だけ**の実証である。旧画像操作では管理画面のmultipart GraphQLが `createImageAsset` を返し、別セッションの読戻しでは既存商品に画像が2枚見えた。旧非公開保存について、要求と応答を同じ商品ID・状態に結び付けた送信契約はまだない。新規の `createProduct` 要求は観測していない。B005795の画像選択・保存には消えない試行マーカーがあり、再送や既存商品IDの再作成はしない。

[公式API仕様](https://api.mercari-shops.com/docs/index.html)には、管理画面内の通信とは別に `createProduct(input: CreateProductInput!)`、SKUの検索に利用できる `products(keyword, after, first)` と `productVariant(by)` がある。`CreateProductInput` は `imageUrls`（HTTPS、20枚以下）、名前、価格、カテゴリー、状態、発送元・発送方法・発送日数・送料負担、バリエーション等を要求する。`UNOPENED` は非公開、`OPENED` は公開である。公式APIはBELLO専用のPersonal API Access Token、契約時のAPI_CLIENT_NAMEを含むUser-Agent、事前申請した日本国内固定送信元IPが必要であり、この店舗でBELLO用の3条件が揃った証拠はない。Next Engineに入力された資格情報を流用しない。

BELLOの既存CSV画像ダウンロードURLはコード上**3600秒の署名URL**である。画像がShops側から期限内に読めること、登録後にどう取り込まれること、署名URLの失効後も商品画像が残ることは未実証。旧管理画面の`createImageAsset`観測から、公式API `imageUrls`へ渡す値やmultipart構造を推測しない。CSVの公開設定は未指定なら**公開**が既定なので、最初の検証の非公開作成へ黙って転用しない。

## 準備した最小モジュール

`tools/bello-mercari-bridge/src/officialSkuLookup.mjs` は、公式API仕様の `products(keyword, after, first)` に基づく**読取専用**のquery構築と、ページごとの厳格な応答判定だけを行う。HTTPクライアント、認証値、`createProduct` mutation、画像送信、PCボタンは持たない。SKUは正確に比較し、同じ店舗から実際に取得した応答を先頭から最終ページまで連続して照合した場合だけ `ABSENT_ON_COMPLETE_SCAN` とする。一致があれば `FOUND`、エラー、壊れた応答、カーソルの再訪は `UNVERIFIED` とする。この純粋関数自体は応答の取得元や鮮度を証明しない。実際のAPI送信と資格情報の確認は未実施。読取から新規作成までに別の操作が入れば、作成直前に重複確認をやり直す必要がある。

## 最初の外部書込より前の条件

1. **別の新規対象を確定する。** BELLO在庫ID・商品管理コード・Shops用SKU、下書きの名前・説明・価格・数量・カテゴリ・状態・配送設定・画像の順序を一商品に固定する。B005795または既存Shops商品ID `2JXePE4ke8UCBTj6mxc4cf` は対象外。BELLOの`ChannelListing`に既存外部IDがある商品、売却・終了・在庫0の商品も対象外。
2. **BELLO専用の公式API資格と送信元を確認する。** Token値はPC画面・文書・ログへ出さない。専用User-Agentと登録済み固定IPから読取APIを正常実行できることを確認する。PC管理画面Cookieで成功した読取は、この条件の代わりにならない。
3. **重複を排除する。** 同じ店舗のSKUを公式APIで全ページ照合し、既存一致や未確認応答なら作成しない。作成試行前にSKUと対象在庫に消えない一回マーカーを置く。通信エラーや応答不明でも新しい作成を再送せず、SKUによる読戻しで照合する。
4. **画像の受渡しを検証する。** BELLOで確定した画像だけを使い、作成前にHTTPS URLの外部到達性と有効期限を確認する。初回の非公開作成後にShops側へ画像が取り込まれ、元URLの失効後も残るか読戻す。短期署名URLが適切かは未確定。画像ファイルの手動追加やB005795への再送で代用しない。
5. **初回書込は非公開の1件に限定する。** `UNOPENED` の入力と、商品ID・SKU・画像・非公開の読戻し計画を具体的に作り、本人が実際の商品・価格・画像を確認してから一度だけ送る。`OPENED` への変更は、画像残存も確認した後に別の本人確認を受ける。

現時点で対象商品、BELLO専用公式API資格、画像URLの到達性、SKU不在の読取証拠が揃っていないため、新規商品作成は行わない。画像の取込と失効後の残存は非公開作成の結果として検証する。BASE連携とNext Engineはこの検証の変更対象にしない。

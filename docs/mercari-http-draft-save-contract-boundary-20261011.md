# メルカリShops HTTP下書き保存の観測境界（2026-10-11）

本人提供のDesktop HARを端末内で解析し、既存のB005396観測記録と照合した。HAR原本、画像、要求・応答本文、認証値、Cookie、個人情報は保存・出力していない。以下の「観測」は実通信の記録、「静的」は同じ画面ビルドのJavaScript、「未確認」は送信契約として使えない部分を表す。

| 段階 | HTTPと順序の証拠 | 入力・応答の証拠 | 境界 |
| --- | --- | --- | --- |
| 今回のDesktop HAR | `POST /graphql` は11件、multipartは0件。下記の画像・下書き作成/更新/読取、停止に当たる名前付き操作は0件。mutationは商品操作ではない `LaplaceLog` が1件。 | 商品下書き/画像asset/停止の応答IDはない。 | このHARは通常ログイン後の読取証拠であり、商品保存契約を追加しない。 |
| 下書き作成（既存B005396 HAR） | `POST https://mercari-shops.com/graphql`、`CreateProductDraft` を短時間に2回。両方HTTP 200、GraphQLエラーなし。 | `CreateProductDraftInput!` と `idempotencyKeySeed: Float!`。同じ名称・SKUでも、応答に異なる下書きID `2JXsGZ5tqLr5Z5SMBXSVUe`、`2JXsGZ7vdfvq7bwbM7dAw9`。 | 一回の保存が自動で重複排除される証拠はない。完全入力の実例とseedの意味は未確定。 |
| 下書き詳細/更新（同HAR） | 最初の下書きを `GetProductDraft` で読取後、2件目に `UpdateProductDraft` を複数回。 | `UpdateProductDraftInput!` は既存下書きID、名称、説明、価格、`assetIds`、カテゴリ、状態、配送、数量・SKU等を含む。価格99,999円、数量1を読戻し。 | 段階的な更新であり、BELLOの全項目を一回で保存できる証拠ではない。 |
| 画像asset（同HAR） | 上記更新の後、`POST /graphql` のmultipart `createImageAsset` がHTTP 200。その後の `UpdateProductDraft` は `assetIds` 1件を送り、画像1件を読戻し。 | 応答にはasset IDとcontentTypeがある。asset IDの値は記録していない。**静的JS**には `CreateImageAsset($input: CreateAssetInput!)`、`file`/`protectionKind`/`public`、FormDataの `operations`/`map`/file part がある。 | HARのmultipart要求本文が欠ける。実ファイル、変換後バイト、part名と値、assetとBELLO原画像の一致は未確認。静的JSを実通信の代用にしない。 |
| 下書き一覧（同HAR） | 画像紐付け後の `productDrafts` 読取では、対象2件が別行として残り、次ページなし。 | 後者は価格99,999円・画像1件、前者は価格0・画像0。 | 同じSKUや名称での一意性は期待できない。結果不明時は一覧の全ページと詳細を読んでも再作成を自動許可しない。 |
| 公開停止/非公開保存 | 今回のDesktop HARにもB005396下書きHARの要約にも、対象商品の停止を示すHTTP操作はない。既存PC画面記録は通常UIでの「非公開で保存する」操作に関するもの。 | 停止用GraphQL operation、入力形、応答商品ID・状態は未観測。 | 下書き更新から公開商品の停止を推測実装しない。 |

関連する元記録: [B005396下書きHAR](mercari-b005396-http-draft-har-evidence-20261009.md)、[画像アップロードのHARと静的JS](mercari-b005396-image-upload-static-source-20261009.md)。今回のDesktop HARは商品書込操作を含まないため、同じ認証状態で商品書込が可能かも証明しない。

## BELLO側で追加した範囲

`webHttpDraftSaveReconciliation.ts` は既存の永続予約を確認し、同じサーバー認証状態で対象店舗を照合してから、将来の下書き一覧読取アダプターが全ページを読み切った結果だけを比較する。対象SKUが1件でも、名称・説明・価格・数量・画像件数まで合致した下書きを「観測した」と返すだけで、当該予約による作成成功とは認定しない。0件、複数件、認証切れ、店舗不一致、一覧未完了、結果不明ではすべて再送不可とする。新規作成・更新・公開の許可はどの結果でも返さない。

独立レビューで、読取候補IDの文字列化により `undefined` 等を正規表現が受け入れる問題を修正した。IDの型と形式が不正な場合は読取未確認で停止する。

画像multipart本文、完全な下書き作成/更新入力、全ページ読取アダプター、停止操作の契約はまだない。従って予約から実際の下書き保存へのHTTP書込器は接続していない。BASEと既存PC操作経路は変更していない。

## 指定された2つのHARの再走査

Desktop `mercari-shops.com.har`（593 entry）とDownloads `mercari-shops.com.har`（536 entry）だけを再走査した。前者はGraphQL 11件、商品操作に関係するmutation 0件。後者はGraphQL 104件で、`CreateProductDraft` 2件、`UpdateProductDraft` 7件、`GetProductDraft` 3件、`productDrafts` 2件、multipartの `createImageAsset` 応答1件を確認した。後者のmutation名は `CreateProductDraft`、`UpdateProductDraft`、商品操作ではない `LaplaceLog` のみ。両HARに停止・公開切替を示すoperation名や該当RESTパスは見つからなかった。これは**この2ファイルの範囲内**の不在である。

| Downloads HARの順序 | 送信先と入力形（値は記録しない） | 応答形 |
| --- | --- | --- |
| entry 101→107 | `POST https://mercari-shops.com/graphql`、JSON `CreateProductDraft`。変数宣言は `$input: CreateProductDraftInput!`、`$idempotencyKeySeed: Float!`。`input` は `name/shopId/description:string`、`price/assetIds/categoryIds/brandIds/condition/shippingFromStateId/shippingDurationType/shippingMethodType:null`、`shippingPayerType/countryRestrictionTemplateId/channelListingScope:string`、`isRefurbished:boolean`、`variants:[{name/skuCode/janCode:string, quantity:number, catalogSkuId/maxQuantityPerOrder:null}]`。seedはnumber。 | 両方HTTP 200、GraphQLエラーなし、`data.createProductDraft.id:string` あり。別IDであることは既存証拠に記録済み。 |
| entry 108→124→142→149→154→247 | `GetProductDraft(id:String!)` で最初の下書きを読み、その後 `UpdateProductDraft(input:UpdateProductDraftInput!)` を段階的に送信。更新inputは既存下書き `id:string` と上記商品項目を持ち、カテゴリ・配送・状態・価格が段階的に `null` から配列/string/numberへ変わる。 | `data.productDraft.id:string` と `data.updateProductDraft.id:string` あり。 |
| entry 357→359→368 | `POST /graphql` multipartの要求本文はHARにない。HTTP 200応答 `data.createImageAsset.id:string` あり。直後のJSON `UpdateProductDraft` は `assetIds:[string]` を含む。後者のvariantsには `catalogSkuId:string` と `attributes:array` もある。 | 更新応答に `data.updateProductDraft.id:string` あり。画像本体・multipart part・asset IDの値は記録しない。 |
| entry 386→470 | JSON `productDrafts(shopId:String!, cursor:String, first:Int)`。変数は `shopId:string`、`first:number`。 | 一覧応答。既存証拠では対象の2下書きが別行。 |

この順序は**2回の作成と複数回の自動更新**を示し、一回の完全な商品保存要求を示さない。特に画像multipart本文と停止契約は依然として不足する。停止を確認するには、別の適切な公開済みテスト商品で通常Chromeのネットワーク記録を開始し、対象IDを確認したうえで「非公開で保存する」を**1回だけ**操作してHARをエクスポートする必要がある。この追加観測は本作業では実行していない。画像multipartの欠落を補うには、画像1枚を伴う下書き保存を通常画面で一回観測し、multipart要求本文が記録されることを確認する別試行が要る。既存B005396への再送はしない。

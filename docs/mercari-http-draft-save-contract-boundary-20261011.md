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

画像multipart本文、完全な下書き作成/更新入力、全ページ読取アダプター、停止操作の契約はまだない。従って予約から実際の下書き保存へのHTTP書込器は接続していない。BASEと既存PC操作経路は変更していない。

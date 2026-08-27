# システムアーキテクチャ

## 1. 目的

自社商品マスター（リユース家具中心）を Single Source of Truth とし、
メルカリShops（将来的にはYahoo!オークションストア、BASE、自社EC等）へ
API経由で出品・同期するためのマルチモール対応商品管理システム。

Mercari Shops固有の画面や操作手順を代替するツールではなく、**自社の在庫・商品管理を
中心に据え、各モールをアダプタ経由で接続する**構造にする（指示書4, 59, 60, 68項）。

## 2. 全体構成

```
                       ┌─────────────────────────┐
                       │        Next.js App        │
                       │  (App Router / TS / Tailwind) │
                       └─────────────┬─────────────┘
                                     │ Server Actions / Route Handlers
                       ┌─────────────▼─────────────┐
                       │      domain/services       │  … ProductService, ListingService,
                       │                             │     CategoryService, ShippingService
                       └─────────────┬─────────────┘
                                     │ MarketplaceAdapter interface
                       ┌─────────────▼─────────────┐
                       │     domain/adapters         │
                       │  MercariShopsAdapter        │  … 将来 YahooAuctionStoreAdapter 等追加
                       └─────────────┬─────────────┘
                                     │
                       ┌─────────────▼─────────────┐
                       │ integrations/mercari-shops  │  … GraphQL Client / queries / mutations
                       └─────────────┬─────────────┘
                                     │ HTTPS (Bearer Token)
                       ┌─────────────▼─────────────┐
                       │  Mercari Shops GraphQL API   │
                       └───────────────────────────┘

                       ┌───────────────────────────┐
                       │  PostgreSQL (Prisma ORM)     │
                       └───────────────────────────┘

                       ┌───────────────────────────┐
                       │  Image Storage               │
                       │  Local (dev) / R2 / S3 (prod) │
                       └───────────────────────────┘
```

## 3. レイヤー責務

| レイヤー | 責務 | 主な禁止事項 |
|---|---|---|
| `app/` (UI, Server Actions) | 画面表示・入力・自社DB保存操作の呼び出し | GraphQLを直接呼ばない（指示書34項） |
| `domain/services` | 自社ドメインロジック（SKU採番、バリデーション、下書き保存、出品オーケストレーション） | Mercari固有の型を直接扱わない |
| `domain/adapters` | `MarketplaceAdapter` インターフェース実装。ドメインモデル⇔各モールAPIの橋渡し | UIやDBアクセスを直接行わない |
| `integrations/mercari-shops` | GraphQLクライアント・クエリ・ミューテーション・API型・enum変換 | ドメインロジックを持たない（薄いAPIラッパーに徹する） |
| `lib/` | Prismaクライアント、暗号化、ストレージ抽象化、ログ | - |

この分離により、Mercari Shops固有の情報（Product ID、Mercari側ステータス等）は
`MercariListing` テーブルへ分離し、`Product` テーブルへ直接持ち込まない
（指示書58項）。

## 4. マルチモール拡張性

```
interface MarketplaceAdapter {
  readonly channel: MarketplaceChannel; // 'MERCARI_SHOPS' | 'YAHOO_AUCTION_STORE' | ...
  createProduct(productId: string): Promise<CreateListingResult>;
  updateProduct(productId: string): Promise<UpdateListingResult>;
  getProduct(externalId: string): Promise<ExternalProduct>;
}
```

- `MercariShopsAdapter` を Phase 1 で実装。
- `IntegrationJob.channel` / `MercariListing` 相当のテーブルはモールごとに用意する
  想定（Phase 3以降、`YahooAuctionListing` 等を追加）。
- `Product` テーブルにはモール固有カラムを追加しない。モール別出品情報は
  各モール専用テーブル（`MercariListing` 等）に閉じ込める。

現段階ではYahoo!オークション連携は実装しない（指示書60項）。

## 5. DB構造（概要）

詳細は `prisma/schema.prisma` を参照。主要モデル：

- `Product` … 自社商品マスター（SKU, 商品名, 説明, 価格, 状態, 内部ステータス等）
- `ProductImage` … 商品画像（並び順・メイン画像フラグ）
- `ProductVariant` … 在庫単位（家具は基本1SKU=在庫1）
- `CategoryMapping` / `BrandMapping` … Mercari側カテゴリー/ブランドのキャッシュ
- `CategoryFavorite` … よく使うカテゴリーのお気に入り
- `ShippingTemplate` / `ShippingTemplateRate` … 自社配送テンプレートとMercari
  ShippingConfigurationの紐付け
- `MercariListing` … Product 1:1、Mercari固有の出品情報（Product IDなど）
- `IntegrationJob` … 出品/更新/同期などのジョブキュー
- `IntegrationLog` … API操作ログ（エラー含む、トークンは保存しない）
- `AppSetting` … トークン（暗号化）、デフォルト値、環境設定
- `DescriptionTemplate` … 商品説明テンプレート

## 6. 商品登録〜出品フロー

1. `/products/new` で自社商品を登録（保存のみ。Mercariへは送信しない）
2. 画像をアップロード（ローカル or R2/S3、`StorageProvider` 抽象化）
3. カテゴリー・ブランド・配送テンプレートなど Mercari Shops設定を入力
4. 商品詳細画面で出品前プレビューを確認（指示書54項）
5. 「メルカリShopsへ出品」ボタン押下 →
   `ListingService.createMercariListing(productId)` が
   入力検証 → SKU重複確認 → 画像URL確認 → カテゴリー確認 → 配送設定確認 →
   `MercariShopsAdapter.createProduct()` を呼び出し
6. `MercariShopsClient` がGraphQL `createProduct` を実行
7. 成功時: `product.id` を `MercariListing` に保存、`Product.internalStatus` を更新
8. 失敗時: `IntegrationLog` にエラーを記録し、画面へエラー表示（指示書39, 40項）

## 7. 画像管理

`StorageProvider` インターフェースを `lib/storage/` に定義し、
`STORAGE_PROVIDER=local|s3|r2` で切替可能にする（指示書11, 12, 3項）。
アップロードされた画像は必ず外部公開URLを返す設計とする（ローカル開発時は
`/uploads/**` として配信）。

## 8. 配送設定

`ShippingTemplate` は自社側マスタとして管理し、`mercariShippingConfigurationId`
で Mercari 側の `createProductShippingConfiguration` 結果と紐付ける
（指示書27〜30項）。商品登録画面ではテンプレートを選ぶだけで配送関連フィールドが
自動反映される。`ShippingService.createShippingConfigurationForTemplate()` が
実際にこのミューテーションを実行し、返却IDをテンプレートへ保存する
（`/settings/shipping` の「Mercariへ配送設定を作成」ボタンから呼び出す）。

配送方法（`ShippingMethod`）はハードコードせず、`ShippingService.getShippingMethods()`
がAPIのSchemaから動的取得し、商品ごとに `Product.shippingMethodCode` として保存する
（指示書26項。取得失敗時のみ `[UNVERIFIED]` フォールバックを表示）。

## 9. ジョブキュー（Phase 2以降で本格稼働）

複数商品の一括出品や同期は `IntegrationJob` テーブルを介した非同期処理とし、
HTTPリクエスト内で同期的に大量処理しない（指示書46項）。Phase 1では単一商品の
同期出品のみを実装し、テーブル構造のみ先に用意する。

## 10. セキュリティ

- Personal API Access Tokenは `lib/crypto.ts`（AES-256-GCM, `ENCRYPTION_KEY` は
  `.env` の秘密鍵）でDB保存前に暗号化。ログ・エラーメッセージ・Gitに出さない。
- `.env` はGit管理外（`.gitignore` 済み）。`.env.example` のみコミット。
- 入力値はサーバ側で `zod` により再検証（クライアント側検証だけに依存しない）。
- アップロードファイルはMIMEタイプ・拡張子・サイズを検証。
- Mercari API呼び出しにはタイムアウトと最大リトライ回数を設定。
- Next.js Server Actions / Route Handlers はCSRF対策済みの仕組みを利用し、
  Reactコンポーネントから秘密情報を扱うAPIを直接呼ばせない。

## 11. Docker

`docker-compose.yml` にて `app`（Next.js）と `db`（PostgreSQL）を定義。
開発者は `docker compose up` でDBを起動し、`npm run dev` でアプリを起動する
（または `app` サービスもコンテナ化して起動）。

## 12. Phase構成

- **Phase 1**: 本ドキュメントのスコープ。商品登録〜Sandbox `createProduct` 成功まで。
- **Phase 2**: Production切替、`updateProduct`、商品同期、複製、一括出品、Job Queue本格化。
- **Phase 3**: 受注管理、Webhook、CSV、売上管理、複数ECモール（Yahoo!オークション等）。

詳細な作業分解は `docs/implementation-plan.md` を参照。

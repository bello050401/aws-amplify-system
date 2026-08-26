# Phase 1 実装計画

指示書61項のPhase 1スコープを細分化したタスクリスト。上から順に実装する。
Phase 1完了条件（指示書62項）を満たすまでPhase 2には着手しない。

## 0. 事前調査（完了）

- [x] `docs/mercari-api.md` … 公式Schema確認を試行（ネットワーク制約により
      `[UNVERIFIED]` を明記した上でベストエフォート版を作成）
- [x] `docs/architecture.md` 作成
- [x] 本ファイル作成

## 1. 基盤構築

- [x] Next.js (App Router) + TypeScript + Tailwind CSS scaffold
- [ ] Prisma導入・`schema.prisma` 作成（Product, ProductImage, ProductVariant,
      CategoryMapping, BrandMapping, CategoryFavorite, ShippingTemplate,
      ShippingTemplateRate, MercariListing, IntegrationJob, IntegrationLog,
      AppSetting, DescriptionTemplate）
- [ ] `docker-compose.yml`（PostgreSQL + app）, `Dockerfile`
- [ ] `.env.example`（DATABASE_URL, MERCARI_ENV, MERCARI_*_ACCESS_TOKEN不要=DB管理,
      ENCRYPTION_KEY, STORAGE_PROVIDER, UPLOAD_DIR 等）
- [ ] `lib/prisma.ts`（PrismaClientシングルトン）
- [ ] `lib/crypto.ts`（トークン暗号化/復号）
- [ ] `lib/storage/`（StorageProvider抽象化、Local実装、S3/R2スタブ）
- [ ] `lib/logger.ts`（IntegrationLog書き込みヘルパー）

## 2. Mercari Shops API クライアント

- [ ] `integrations/mercari-shops/endpoints.ts`
- [ ] `integrations/mercari-shops/MercariShopsClient.ts`
      （fetchベース, timeout, 指数バックオフretry, エラー握り潰し禁止）
- [ ] `integrations/mercari-shops/types/limits.ts`（文字数上限などの定数集約）
- [ ] `integrations/mercari-shops/types/*.ts`（CreateProductInput等、UNVERIFIED明記）
- [ ] `integrations/mercari-shops/queries/{categories,brands,shippingOptions}.ts`
- [ ] `integrations/mercari-shops/mutations/{createProduct,createProductShippingConfiguration}.ts`
- [ ] `integrations/mercari-shops/mapper/{condition,shippingPayer,productStatus}.ts`
      （API enum ⇔ 日本語ラベル 変換表を1箇所に集約）
- [ ] codegen設定（`graphql-codegen`。実行は将来、実Schema到達可能な環境で）

## 3. ドメイン層

- [ ] `domain/adapters/MarketplaceAdapter.ts`（インターフェース）
- [ ] `domain/adapters/MercariShopsAdapter.ts`（実装）
- [ ] `domain/services/SkuGenerator.ts`（`BELLO-000001`形式の自動採番＋手入力対応）
- [ ] `domain/services/ProductService.ts`（CRUD、下書き保存、複製）
- [ ] `domain/services/ListingService.ts`（出品オーケストレーション：検証→Adapter呼出→保存→ログ）
- [ ] `domain/services/CategoryService.ts` / `BrandService.ts` / `ShippingService.ts`

## 4. API Route / Server Actions

- [ ] `app/api/products` (GET一覧/POST作成)
- [ ] `app/api/products/[id]` (GET/PATCH/DELETE)
- [ ] `app/api/products/[id]/duplicate` (POST)
- [ ] `app/api/products/[id]/images` (POST追加/PATCH並び替え/DELETE)
- [ ] `app/api/uploads` (POST、multipart、MIME/サイズ検証)
- [ ] `app/api/mercari/listings/[productId]` (POST=出品実行)
- [ ] `app/api/mercari/categories` (GET、DBキャッシュ優先、なければAPI取得)
- [ ] `app/api/mercari/brands` (GET、検索クエリ対応)
- [ ] `app/api/settings/mercari` (GET/POST、トークン暗号化保存)
- [ ] `app/api/settings/templates` (説明テンプレートCRUD)

## 5. 画面

- [ ] `/dashboard`（指示書51項の集計）
- [ ] `/products`（一覧・複数選択・ステータスバッジ・操作ボタン）
- [ ] `/products/new`（セクション分割フォーム: 基本情報/画像/商品状態/在庫/配送/Mercari設定）
- [ ] `/products/[id]`（編集＋出品プレビューダイアログ＋「メルカリShopsへ出品」）
- [ ] `/settings/templates`（商品説明テンプレート管理）
- [ ] `/settings/mercari`（トークン設定、Sandbox/Production表示）
- [ ] `/settings/shipping`（配送テンプレート管理）
- [ ] `/settings/categories`（カテゴリーお気に入り管理）
- [ ] `/logs`（APIログ一覧）

## 6. コンポーネント

- [ ] `ImageUploader`（複数選択・D&D・並び替え・メイン画像指定）
- [ ] `CategoryPicker`（階層選択、末端のみ確定可能）
- [ ] `BrandPicker`（検索付き）
- [ ] `ShippingTemplateSelect`
- [ ] `ListingPreviewDialog`（出品前確認、指示書54項）
- [ ] `ProductStatusBadge`
- [ ] `ProductTable`（複数選択対応）

## 7. Sandbox接続確認

- [ ] `/settings/mercari` からSandboxトークンを登録
- [ ] カテゴリー/ブランド取得確認
- [ ] サンプル商品（柏木工 KASHIWA ウィンザーチェア、画像10枚、¥29,800、
      「目立った傷や汚れなし」）を登録し、「メルカリShopsへ出品」を実行
- [ ] `createProduct` 成功 → `product.id` 保存 → 画面に「メルカリShops：出品成功」表示

上記が実機（有効なSandboxトークン・ネットワーク到達性のある環境）で確認できた時点で
Phase 1完了とする。

## 8. 各タスク完了時の確認事項（指示書67項）

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npx prisma migrate dev` / `npx prisma validate`
- （テストを追加した範囲）`npm test`

## Phase 2 / Phase 3

`docs/architecture.md` の10, 12節、指示書63, 64項を参照。Phase 1完了条件を満たすまで
着手しない。

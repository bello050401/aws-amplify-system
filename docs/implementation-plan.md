# Phase 1 実装計画

指示書61項のPhase 1スコープを細分化したタスクリスト。上から順に実装する。
Phase 1完了条件（指示書62項）を満たすまでPhase 2には着手しない。

**2026-08-27追記**: 下記タスクはすべて実装・ローカル検証済み。現在の段階については
本ファイル末尾の「9. 現在のステータス」を参照。

## 0. 事前調査（完了）

- [x] `docs/mercari-api.md` … 公式Schema確認を試行（ネットワーク制約により
      `[UNVERIFIED]` を明記した上でベストエフォート版を作成）
- [x] `docs/architecture.md` 作成
- [x] 本ファイル作成

## 1. 基盤構築

- [x] Next.js (App Router) + TypeScript + Tailwind CSS scaffold
- [x] Prisma導入・`schema.prisma` 作成（Product, ProductImage, ProductVariant,
      CategoryMapping, BrandMapping, CategoryFavorite, ShippingTemplate,
      ShippingTemplateRate, MercariListing, IntegrationJob, IntegrationLog,
      AppSetting, DescriptionTemplate）
- [x] `docker-compose.yml`（PostgreSQL + app）, `Dockerfile`
- [x] `.env.example`（DATABASE_URL, MERCARI_ENV, ENCRYPTION_KEY, STORAGE_PROVIDER,
      UPLOAD_DIR 等。Personal Access Tokenは`.env`に書かずDBへ暗号化保存）
- [x] `lib/prisma.ts`（PrismaClientシングルトン）
- [x] `lib/crypto.ts`（トークン暗号化/復号、単体テスト付き）
- [x] `lib/storage/`（StorageProvider抽象化、Local実装、S3/R2スタブ）
- [x] `lib/logger.ts`（IntegrationLog書き込みヘルパー）

## 2. Mercari Shops API クライアント

- [x] `integrations/mercari-shops/endpoints.ts`
- [x] `integrations/mercari-shops/MercariShopsClient.ts`
      （fetchベース, timeout, 指数バックオフretry, エラー握り潰し禁止。
      実際のネットワーク経路まで到達することをローカルで確認済み — docs参照）
- [x] `integrations/mercari-shops/types/limits.ts`（文字数上限などの定数集約）
- [x] `integrations/mercari-shops/types/*.ts`（CreateProductInput等、UNVERIFIED明記）
- [x] `integrations/mercari-shops/queries/{categories,brands,shippingOptions}.ts`
- [x] `integrations/mercari-shops/mutations/{createProduct,createProductShippingConfiguration}.ts`
- [x] `integrations/mercari-shops/mapper/{condition,shippingPayer,shippingDuration,productStatus}.ts`
      （API enum ⇔ 日本語ラベル 変換表を1箇所に集約、単体テスト付き）
- [ ] codegen設定（`graphql-codegen`。実行は将来、実Schema到達可能な環境で。
      `npm run mercari:codegen` にプレースホルダーあり）

## 3. ドメイン層

- [x] `domain/adapters/MarketplaceAdapter.ts`（インターフェース）
- [x] `domain/adapters/MercariShopsAdapter.ts`（createProduct実装、updateProductはPhase2）
- [x] `domain/services/SkuGenerator.ts`（`BELLO-000001`形式の自動採番＋手入力対応、単体テスト付き）
- [x] `domain/services/ProductService.ts`（CRUD、複製）
- [x] `domain/services/ListingService.ts`（出品オーケストレーション：検証→Adapter呼出→保存→ログ）
- [x] `domain/services/CategoryService.ts` / `BrandService.ts` / `ShippingService.ts`
      （`ShippingService`は配送方法の動的取得と`createProductShippingConfiguration`実行も担当）

## 4. API Route / Server Actions

- [x] `app/api/products` (GET一覧/POST作成)
- [x] `app/api/products/[id]` (GET/PATCH/DELETE)
- [x] `app/api/products/[id]/duplicate` (POST)
- [x] `app/api/products/[id]/images` (POST追加/PATCH並び替え/DELETE)
- [x] `app/api/products/[id]/listing` (POST=出品実行)
- [x] `app/api/mercari/categories` (GET、DBキャッシュ優先、POSTで再取得)
- [x] `app/api/mercari/brands` (GET、検索クエリ対応)
- [x] `app/api/mercari/shipping-methods` (GET、動的取得＋フォールバック)
- [x] `app/api/settings/mercari` (GET/POST、トークン暗号化保存)
- [x] `app/api/settings/templates` (説明テンプレートCRUD)
- [x] `app/api/settings/shipping` (配送テンプレートCRUD)
- [x] `app/api/settings/shipping/[id]/create-configuration`
      (POST=`createProductShippingConfiguration`実行)
- [x] `app/uploads/[...path]` (ローカルストレージ画像配信、開発用)

## 5. 画面

- [x] `/dashboard`（指示書51項の集計）
- [x] `/products`（一覧・複数選択・ステータスバッジ・操作ボタン）
- [x] `/products/new`（セクション分割フォーム: 基本情報/画像/商品状態/在庫/配送/Mercari設定）
- [x] `/products/[id]`（編集＋出品プレビューダイアログ＋「メルカリShopsへ出品」）
- [x] `/settings/templates`（商品説明テンプレート管理）
- [x] `/settings/mercari`（トークン設定、Sandbox/Production表示、デフォルト値設定）
- [x] `/settings/shipping`（配送テンプレート管理、都道府県別送料、Mercari配送設定作成）
- [x] `/settings/categories`（カテゴリーお気に入り管理）
- [x] `/logs`（APIログ一覧）

## 6. コンポーネント

- [x] `ImageUploader`（複数選択・D&D・並び替え・メイン画像指定）
- [x] `CategoryPicker`（階層選択、末端のみ確定可能）
- [x] `BrandPicker`（検索付き）
- [x] `ShippingTemplateSelect` / `ShippingMethodSelect`
- [x] `ListingPreviewDialog`（出品前確認、指示書54項）
- [x] `ProductStatusBadge`
- [x] `ProductTable`（複数選択対応）

## 7. Sandbox接続確認（未実施 — 人間の操作が必要）

- [ ] `/settings/mercari` からSandboxトークンを登録
- [ ] カテゴリー/ブランド取得確認
- [ ] サンプル商品（柏木工 KASHIWA ウィンザーチェア、画像10枚、¥29,800、
      「目立った傷や汚れなし」）を登録し、「メルカリShopsへ出品」を実行
- [ ] `createProduct` 成功 → `product.id` 保存 → 画面に「メルカリShops：出品成功」表示

上記が実機（有効なSandboxトークン・ネットワーク到達性のある環境）で確認できた時点で
Phase 1完了とする。**Claude Codeの開発サンドボックスは `api.mercari-shops.com` /
`api.mercari-shops-sandbox.com` へのネットワークアクセスがブロックされているため、
この最終確認はClaude Codeだけでは完了できない**（docs/mercari-api.md 参照）。

## 8. 各タスク完了時の確認事項（指示書67項）

- `npm run typecheck` … ✅ 通過
- `npm run lint` … ✅ 通過
- `npm run build` … ✅ 通過
- `npx prisma migrate dev` / `npx prisma validate` … ✅ 通過
- `npm test`（vitest, 29件）… ✅ 通過

## 9. 現在のステータス（2026-08-27時点）

- **実装**: Phase 1スコープのコードはすべて完了。ローカル環境（このセッションのコンテナ、
  実PostgreSQL使用）で商品登録→画像アップロード→カテゴリー/ブランド設定→出品オーケストレーション
  →GraphQLクライアント呼び出し→エラーハンドリング→ログ記録、までの一連の流れを実際に
  curlで通し、想定通りに動作することを確認済み。
- **未検証**: 実際のMercari Shops Sandbox API相手に`createProduct`が成功すること
  （Personal API Access Tokenの取得・登録、および開発環境からのネットワーク到達性の両方が必要）。
- **ブロッカー**: 本Claude Code開発サンドボックスは `api.mercari-shops.com` /
  `api.mercari-shops-sandbox.com` への外部通信がネットワークポリシーにより遮断されている
  （`WebFetch`は`EGRESS_BLOCKED`、Node標準`fetch`も同ホストに対し
  `403 Host not in allowlist`を返す）。これは人による認証・契約が必要な領域であり、
  Claude Codeの権限では解消できない。

## Phase 2 / Phase 3

`docs/architecture.md` の10, 12節、指示書63, 64項を参照。Phase 1完了条件を満たすまで
着手しない。

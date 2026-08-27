# 家具リユース商品管理システム（メルカリShops自動出品）

自社商品マスターを Single Source of Truth とし、メルカリShops公式GraphQL APIへ
自動出品する商品・在庫管理システム（Phase 1）。詳細な設計は `docs/` を参照してください。

- `docs/architecture.md` … システム構成・DB構造・出品フロー
- `docs/mercari-api.md` … メルカリShops API調査メモ（**重要**: 本開発環境からは
  ネットワーク制約により公式GraphQL Schemaへ直接アクセスできなかったため、暫定値に
  `[UNVERIFIED]` を明記しています。Sandbox接続前に必ず一読してください）
- `docs/implementation-plan.md` … Phase 1の作業分解

## セットアップ

### 1. 依存関係インストール

```bash
npm install
```

### 2. 環境変数

```bash
cp .env.example .env
```

`.env` の `ENCRYPTION_KEY` を生成して設定してください（Personal API Access Token
暗号化用）。

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3. PostgreSQL起動（Docker）

```bash
docker compose up -d db
```

### 4. マイグレーション & 初期データ

```bash
npx prisma migrate dev
npx prisma db seed
```

### 5. 開発サーバー起動

```bash
npm run dev
```

`http://localhost:3000` へアクセス（`/dashboard` へリダイレクトされます）。

### 6. メルカリShops連携設定

1. `/settings/mercari` でSandbox用 Personal API Access Token を登録
2. `/settings/categories` で「メルカリShopsからカテゴリーを再取得」を実行
3. `/products/new` で商品を登録し、画像をアップロード
4. 商品詳細画面から「メルカリShopsへ出品」を実行

`MERCARI_ENV` は `.env` で `sandbox` / `production` を切り替えます。**Phase 1完了条件
（`docs/mercari-api.md` 7節）を満たすまでは必ず `sandbox` を使用してください。**

## 開発時の確認コマンド

```bash
npm run typecheck
npm run lint
npm run build
npm test
npx prisma validate
```

## ディレクトリ構成（抜粋）

```
src/
  app/                … 画面 (App Router) と Route Handlers
  components/          … UIコンポーネント
  domain/
    adapters/           … MarketplaceAdapter (MercariShopsAdapter)
    services/            … ドメインロジック（商品CRUD, 出品オーケストレーション等）
    validation/          … zodスキーマ
  integrations/
    mercari-shops/       … Mercari Shops GraphQLクライアント・型・enum変換
  lib/                  … Prisma, 暗号化, ストレージ抽象化, ログ
prisma/
  schema.prisma
  seed.ts
docs/
  architecture.md
  mercari-api.md
  implementation-plan.md
```

## 実装状況

Phase 1（商品登録 → 画像登録 → メルカリShops設定 → Sandbox出品 → Product ID保存まで）の
実装は完了しており、ローカル環境（実PostgreSQL、Mercari APIクライアントの実際の
ネットワーク呼び出しパス）で動作確認済みです。ただし**実際のMercari Shops Sandbox APIとの
接続確認（Personal API Access Tokenの取得・登録、`createProduct`実成功）はまだ行われて
いません**。理由と再現手順は `docs/implementation-plan.md` 9節・`docs/mercari-api.md` を
参照してください。Phase 2（Production切替、`updateProduct`、商品同期、一括出品等）は
Phase 1完了条件を満たした後に着手します。

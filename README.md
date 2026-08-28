# BELLO在庫管理システム

家具・家電等の在庫を、倉庫・撮影現場・ショールームで管理するための在庫管理システム。
PC版・iPhone(PWA)版は同一のAWSバックエンド・同一データ・同一業務ロジックを共有する。

> **重要な前提**: このリポジトリには本実装を始めた時点で `index.html` 1枚のみが存在し、
> 「開発中の既存BELLOシステム」は見つかりませんでした。そのため本実装では、指示書 §33
> の方針(コア機能が未完成ならまずコア機能を完成させる)に従い、AWS Amplify Gen2による
> バックエンドと在庫管理の中核機能を新規に構築し、その上にPC版・iPhone/PWA版の
> レスポンシブUIを1つのアプリとして実装しました。既存のBELLOシステムが実際には
> 別の場所に存在する場合は、そちらへ本実装のデータモデル/コンポーネントを移植する
> 形で統合してください。

## 技術スタック

- **フロントエンド**: Next.js 14 (App Router) + TypeScript + Tailwind CSS
- **バックエンド**: AWS Amplify Gen2 (`amplify/`) — Amazon Cognito(認証) / AWS AppSync + Amazon DynamoDB(データ) / Amazon S3(画像)
- **バーコード/QR**: `@zxing/browser`
- **バリデーション**: `zod`
- **テスト**: `vitest`

## ディレクトリ構成

```
amplify/            Amplify Gen2 バックエンド定義 (認証・データモデル・ストレージ)
app/                Next.js App Router (PC版・モバイル版 共通、レスポンシブ)
  (main)/           ログイン後の全画面(ホーム/在庫一覧/詳細/編集/入出庫/棚卸/一括操作/スキャン/検索)
  login/            ログイン画面
components/         共通UIコンポーネント (指示書 §29 に対応)
lib/
  api/              DataSource(永続化層)・InventoryService(業務ロジック)・Mock/Amplify実装
  auth/             認証コンテキスト(Cognito / ローカルモック)
  search/           詳細検索の条件評価・GraphQLフィルタ変換
  validation/       フォームバリデーション(zod)
  utils/            日付・価格・画像処理等の共通ユーティリティ
public/             PWAマニフェスト・アイコン・Service Worker
scripts/            アイコン生成スクリプト
```

## バックエンドの状態と使い方

このセッションには実AWSアカウントの認証情報がないため、Amplifyバックエンドは
**コードとしては完成していますが、実際にAWSへデプロイされていません**。
`amplify_outputs.json` はプレースホルダー(`"__PLACEHOLDER__": true`)のままです。

### ローカル動作確認モード(現在の状態)

`amplify_outputs.json` がプレースホルダーの間、アプリは自動的に
`lib/api/mockDataSource.ts`(ブラウザのlocalStorageに保存される疑似DB)と
簡易モック認証(任意のメール/パスワードでログイン可、`admin`を含むメールはAdmins権限)
で動作します。`npm run dev` するだけで全画面を実際に操作して確認できます。

### 実AWSへデプロイする方法(ユーザー本人のAWS認証が必要)

```bash
npm install
npx ampx sandbox        # 開発用: Cognito/AppSync/DynamoDB/S3を個人サンドボックスにデプロイ
# または
npx ampx pipeline-deploy --branch <branch> --app-id <amplify-app-id>   # 本番CI/CD用
```

デプロイが成功すると `amplify_outputs.json` が実際のエンドポイント情報で自動上書きされ、
アプリは**コード変更なしに**自動的に実AWSバックエンド(`lib/api/amplifyDataSource.ts`)へ
切り替わります。PC版・モバイル版は常にこの同一バックエンドを参照します。

## 開発コマンド

```bash
npm run dev         # 開発サーバー起動 (http://localhost:3000)
npm run build        # 本番ビルド (lint + 型チェック含む)
npm run typecheck    # 型チェックのみ
npm run lint         # ESLintのみ
npm test             # vitestによる単体テスト
node scripts/generate-icons.mjs   # PWAアイコン再生成
```

## PWA(iPhoneホーム画面追加)

`public/manifest.webmanifest` / `public/sw.js` / `public/icons/*` を用意済みです。
iPhone Safariで開き、共有 → 「ホーム画面に追加」で、standaloneアプリとして起動できます。
アイコン・配色・ロゴはBELLO独自(ZAICO等の資産は不使用)。

## 既知の制約・今後の課題

- 実AWSデプロイ・実機(カメラ権限含む)での最終確認はユーザー本人の作業が必要です。
- 楽観ロックはアプリケーション層での読み直し比較によって実装しています。より厳密な
  同時更新対策が必要な場合は、DynamoDBの条件付き書き込み(カスタムリゾルバ)への
  置き換えを検討してください。
- 在庫件数が非常に多い(数万件超)場合、AppSyncのfilterはテーブルスキャン後の絞り込みに
  なるため、将来的には検索専用のインデックス(OpenSearch等)の追加を検討してください。
- 完全オフライン対応(在庫データそのもののキャッシュ)は要件外のため未実装です。

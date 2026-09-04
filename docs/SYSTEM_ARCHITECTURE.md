# BELLO 在庫管理システム 構成図（2026-09-04 時点）

コードから起こした現状の姿です。「こうあるべき」ではなく**いまそう動いているもの**を書いています。

規模: TypeScript 71,968行 / 画面19 / APIルート5 / Server Action 30ファイル / データモデル60超

---

## 1. 全体像

```
                    ┌──────────────── ブラウザ ────────────────┐
                    │  /inventory  /inventory/settings          │
                    │  /admin      /features/[slug]（公開）      │
                    └───────────────┬──────────────────────────┘
                                    │ Server Component / Server Action
                    ┌───────────────▼──────────────────────────┐
                    │  Next.js 14 App Router（Amplify SSR）      │
                    └───┬──────────────┬────────────────┬──────┘
                        │              │                │
        AppSync(Cognito)│   DynamoDB直結 │        外部API │
                        │  (未認証経路)   │                │
                ┌───────▼──────┐  ┌────▼────┐  ┌────────▼─────────┐
                │  AppSync      │  │DynamoDB │  │ Gmail / LINE /   │
                │  (GraphQL)    │  │(直接)    │  │ BASE / ZAICO /   │
                └───────┬───────┘  └────┬────┘  │ Mercari / Bedrock│
                        └────────┬───────┘       └──────────────────┘
                            ┌────▼────┐
                            │DynamoDB │
                            └─────────┘
```

### 2つのデータアクセス経路（重要）

| 経路 | 使う場面 | 認可 | 実装 |
|---|---|---|---|
| **AppSync 経由** | ログイン中の画面・Server Action | Cognitoグループ（ADMIN/EDITOR/VIEWER/Admins）をAppSyncが判定 | `serverDataClient`（Cookieベース） |
| **DynamoDB 直結** | LINE Webhook・メール取込・一部の高速化 | SSR実行ロールのIAM。呼び出し側が事前に権限を確かめる | `runWithDirectData()` / `directData.ts`、および `inventoryCountFast.ts` `inventorySearchFast.ts` `webhookStore.ts` |

**なぜ2つあるか**: LINE Webhook はLINEプラットフォームからの未認証POSTで、Cookieもセッションも
無いためAppSyncが必ず弾きます。実際に「LINEから届いたメッセージが1件もBELLOに入らない」状態を
実機で踏んだ経緯があります。

**気をつける点**: 直結側はAppSyncのリゾルバを通らないため、AppSyncが自動で付ける振る舞いが
そのままでは無い。実際に `create` の `attribute_not_exists(id)` が抜けており、
重複防止のclaimが機能しない状態でした（2026-09-04に修正）。

---

## 2. 画面

| パス | 役割 | 認証 |
|---|---|---|
| `/inventory` | 在庫一覧（検索・絞り込み・ページング・件数） | `(protected)` layout |
| `/inventory/[id]` | 商品詳細 | 同上 |
| `/inventory/[id]/edit` | 編集 | 同上（EDITOR以上） |
| `/inventory/[id]/listing` | EC出品（説明文AI生成・配送方法選択） | 同上 |
| `/inventory/new` | 新規登録 | 同上 |
| `/inventory/messages` | 問い合わせ・会話 | 同上 |
| `/inventory/listings` | 出品一覧・価格ルール | 同上 |
| `/inventory/sales` | 売上 | 同上 |
| `/inventory/settings` | カテゴリ/単位/保管場所/**状態**/追加項目/一覧列/各種連携 | 同上（書き込みはADMIN） |
| `/admin`, `/admin/search`, `/admin/features/[id]`, `/admin/settings` | 特集（BASE商品のキュレーション） | `Admins` グループ |
| `/features/[slug]` | 公開特集ページ | 公開（apiKey読み取り） |
| `/inventory/login`, `/admin/login` | ログイン | 公開 |

---

## 3. 主要なデータフロー

### 3.1 問い合わせ（LINE / メール）→ AI返信案 → 内部通知

```
LINE Webhook (POST /api/line/webhook)
  └ x-line-signature を生の本文で検証（不正なら401）
      └ webhookStore.recordIncomingWebhookMessage        ← DynamoDB直結
          ├ externalMessageId のGSIで既取込を判定
          ├ 会話を特定 or 作成（channel + externalCustomerId、無ければ表示名で補助照合）
          └ Message を条件付きPut（id は externalMessageId から決まる ＝ 二重登録できない）
              └ autoReply.processInquiryAndNotify        ← runWithDirectData の中
                  ├ 商品特定（productResolver）
                  │   BASE商品 / ChannelListing / 在庫名の照合、
                  │   メルカリは注文番号 → MercariOrderContext
                  ├ 会話コンテキスト構築（conversationContext）
                  ├ AI返信案生成（Bedrock）→ ReplyDraft
                  └ LINE通知（lineNotify.notifyInquiry）
                      dedupeKey = channel:conversationId:sourceMessageId
                      id = dedupeKey の条件付き作成 ＝ 二重送信できない

Gmail 取込（メール）も同じ下流へ合流する。
メルカリの購入通知だけは Conversation / AI返信 / LINE通知 / 通知履歴を
**作らない**（注文番号→商品の対応表 MercariOrderContext を作るだけ）。
```

### 3.2 在庫（ZAICO → BELLO → EC出品）

```
ZAICO API（読み取り専用。BELLOからZAICOへは絶対に書かない）
  └ zaicoSyncEngine / zaicoSyncPorts
      ├ ZaicoSourceLink で sourceInventoryId を原子的にclaim（重複作成の根治）
      ├ Inventory を作成 or 更新（listingPartition / listUpdatedAt を必ず設定）
      └ InventoryHistory に差分を記録

Inventory
  ├ 一覧: listingPartition="ACTIVE" のGSIを listUpdatedAt DESC でQuery（表示ページ分だけ）
  ├ 件数: DynamoDB直結の Select:COUNT を並列Scanで
  ├ 検索: 直結の並列Scan（参照する列だけを射影）→ 表示50件だけGetItemで実体化
  └ EC出品: ListingDraft → BASE / Mercari
```

### 3.3 在庫を書き換える経路（全11）

| 経路 | listUpdatedAt | 件数キャッシュ無効化 |
|---|---|---|
| `app/actions/inventory.ts` 新規登録 | 設定 | あり |
| 同 編集 | 更新 | あり |
| 同 削除 | — | あり |
| `app/actions/inventoryBulkEdit.ts` 一括/インライン編集 | 更新 | あり |
| `lib/inventory/inventoryImport.ts` CSV取込（作成/更新） | 設定/更新 | あり |
| `lib/inventory/zaicoSyncPorts.ts` 同期（作成/更新） | 設定/更新 | あり |
| `lib/inventory/zaicoDuplicateAudit.ts` 重複統合（削除） | — | あり |
| `lib/inventory/masterDedupe.ts` マスタ統合 | 更新 | — |
| `lib/inventory/listingPartitionBackfill.ts` | 既存値を複製 | — |
| `lib/inventory/thumbnailBackfill.ts` | **意図的に触らない** | — |
| `lib/inventory/originalHashRepair.ts` | **意図的に触らない** | — |

最後の2つが `listUpdatedAt` を更新しないのは、内部的な書き込みが一覧の並び順を
押し上げないようにするためです（過去に実際そうなった経緯があります）。

---

## 4. データモデル（主要なもの）

| 分類 | モデル |
|---|---|
| 在庫 | `Inventory` `InventoryHistory` `InventoryImage`(型) |
| マスタ | `Category` `Location` `UnitMaster` `StatusMaster` `CustomFieldDefinition` |
| ZAICO | `ZaicoSyncJob` `ZaicoSourceLink` |
| 出品 | `ListingDraft` `ChannelListing` `PricingRule` `PriceHistory` |
| 会話 | `Conversation` `Message` `ReplyDraft` `ReplyRule` `AIReplySettings` |
| メルカリ | `MercariOrderContext` |
| 通知 | `NotificationDelivery` `LineNotifySettings` |
| 配送 | `ShippingRate` `ShippingImportBatch` |
| AI | `AIUsageLog` `KnowledgeDocument` `ProductDescriptionGuidance` `GeneratedProductPage` `BelloStyleProfile` |
| 画像 | `ProcessingJob` `ImageProcessingVersion` `PhotoProfile` |
| 特集(BASE) | `Feature` `FeatureItem` `BaseItemCache` `BaseOAuthToken` `BaseProductArchive` |
| 集計 | `SalesMonthlyAggregate` |

一意キーを `id` 以外にしているモデル（＝ここが重複防止の要）:
`BaseItemCache(baseItemId)` / `MercariOrderContext(orderId)` /
`BaseProductArchive(baseItemId)` / `SalesMonthlyAggregate(yearMonth)` /
`ExternalResearchCache(cacheKey)`

---

## 5. 外部連携

| 相手 | 用途 | 認証情報の置き場 | タイムアウト |
|---|---|---|---|
| Gmail | 問い合わせメールの取込 | Secrets Manager `bello/gmail-oauth` | 15秒 |
| LINE Messaging | 受信Webhook・添付/プロフィール取得 | `bello/line-channel-secret` | 15秒 |
| LINE 通知Bot | 社内への通知push | `bello/line-notify-bot` | 15秒 |
| BASE | 商品検索・特集・出品 | `bello/base-app-credentials`（OAuthトークンは`BaseOAuthToken`） | 15秒 |
| ZAICO | 在庫の読み取り同期（**書き込みは一切しない**） | `bello/zaico-api-token` | 15秒 |
| Mercari Shops | 出品（中継経由） | `bello/mercari-access-token` / `bello/mercari-relay` | 15秒（従来から） |
| Bedrock | 返信案・商品説明の生成 | IAM（SSR実行ロール） | SDK既定 |

Secretはすべて `bello/<用途>` の名前でSecrets Managerに置き、SSR実行ロールの
インラインポリシーで**ARNを明示列挙**して許可しています（`Resource:"*"` ではない）。
Secretを増やしたら、そのポリシーへの追記が別途必要です。

---

## 6. バックグラウンド処理

| 処理 | 起動 | 実装 |
|---|---|---|
| ZAICO同期（バッチ） | 設定画面から手動 / ワーカー | `zaicoBackgroundSync.ts` |
| 画像処理 | ジョブキュー | `imageProcessing/jobService.ts` |
| 価格改定 | スケジューラ | `pricing` |
| サムネイル生成バックフィル | 設定画面から手動（分割実行） | `thumbnailBackfill.ts` |
| listingPartition バックフィル | 設定画面から手動（分割実行） | `listingPartitionBackfill.ts` |
| ZAICO重複監査・統合 | 設定画面から手動（1件ずつ） | `zaicoDuplicateAudit.ts` |

バックフィル系は「1回の呼び出しで高々N件、`nextToken` を返して再開可能、
何度実行しても安全（冪等）」で統一されています。

---

## 7. キャッシュ

| キャッシュ | 範囲 | TTL | 無効化 |
|---|---|---|---|
| `requestCache`（React `cache()`） | 1リクエスト内 | リクエスト終了まで | 不要 |
| `masterCache` | プロセス内 | 60秒 | マスタの書き込み関数の中で必ず呼ぶ |
| `inventoryCountCache` | プロセス内 | 60秒 | 在庫の件数が変わる全経路で呼ぶ（一覧はそのファイルに列挙） |
| `orderScanCache`（商品特定の走査） | プロセス内 | 短時間 | — |
| Next.js `revalidatePath("/inventory")` | サーバー描画 | 書き込みごと | Server Action の中で呼ぶ |

いずれもプロセスローカルです。SSRのLambdaは複数インスタンスに分かれるので、
無効化が効くのは同じインスタンスだけ。「自分が今書き換えた直後に古い値を見る」という
一番目に付くケースを潰すための設計で、分散キャッシュではありません。

---

## 8. 計測・検証の入口

| コマンド | 内容 |
|---|---|
| `npm run measure:performance` | 画面ごとのDynamoDB/Secrets実測（往復・件数・転送量・時間） |
| `npm run measure:inventory-search` | 検索の新旧比較 |
| `npm run measure:page-loads` | ページ単位のサーバー処理時間 |
| `npm run verify:data-integrity` | 実データの孤児・重複・欠落（読み取り専用） |
| `npm run verify:inventory-search-fast` | 検索結果の新旧一致（実データ46通り） |
| `npm run verify:inventory-count` | 件数の新旧一致（実データ） |
| `npm run verify:notification-claim-live` | 通知の二重送信防止（実DynamoDB） |
| `npm run verify:http` | 外部呼び出しのタイムアウト（外部につながない） |
| `BELLO_QUERY_TIMING=1` | リクエスト内のデータアクセスを Server-Timing で収集（既定は無効） |

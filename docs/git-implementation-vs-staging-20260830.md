# Git蓄積実装 × Staging 照合 (8b145f6 → HEAD)

改訂版指示書 §6 / Phase 4 に対応。目的は「34commitを作り直すこと」では
なく、**GitHubに何が既にあったか / job #65以降のStagingへ何が初めて
反映されたか / deploy後にruntimeで何が壊れたか / 本当に未実装なのは何か**
を分離すること。

## 1. 期間の性質

`8b145f6`(job #29、長期間最後の成功build) 以降 HEAD までに **42 commit**。
うち **34 commit** は、Gitへ入っていながら **AWS上で一度も動いたことが
なかった**——build job #30〜#64 が全て失敗していたため。残り8commitが
今回の復旧・統合作業。

つまりこの期間は「実装が止まっていた期間」ではなく
**「Git蓄積・AWS未検証期間」**である。

変更領域(commit数 / 変更ファイル延べ):
`app/` 19本/80 ・ `lib/` 23本/79 ・ `amplify/` 15本/31 ・
`scripts/` 22本/29 ・ `docs/` 18本/23 ・ `e2e/` 4本/4

## 2. job #65/#66 で初めてAWSへ到達した主要機能

| commit | 機能 | AWS上の実体 | 実測状態 |
|---|---|---|---|
| `bbdcd34` | Background Jobs (EventBridge Scheduler → Lambda) | `pricing-scheduler` Lambda + schedule | **AWS_VERIFIED** — 毎時ENABLEDで稼働、`[pricing-scheduler] 0 channel listing` の正常ログ(0件はChannelListingが空のため) |
| `7cf411a` | ZAICO同期のブラウザ非依存化 | `zaico-sync-worker` Lambda + 5分schedule | **AWS_VERIFIED** — 全1000件の同期を219秒で完走したログを確認 |
| `42a0c7e` `851fa6d` | 画像自動加工パイプライン | `image-processing-worker` Lambda + 5分schedule + ProcessingJob/ImageProcessingVersion/PhotoProfile | **AWS_DEPLOYED** — sharp修正後INIT成功・エラー0。ただし実ジョブ処理はProcessingJobが空のため未実証 |
| `e6c88cc` | ZAICO重複根絶(ZaicoSourceLink) | `ZaicoSourceLink` テーブル | **AWS_VERIFIED** — 1,000件のリンクが実在、重複0を実証 |
| `69f369c` | 一覧のカーソルページネーション | GSI `inventoriesByListingPartitionAndListUpdatedAt` | **AWS_DEPLOYED**(後述、経路は未接続) |
| `e19779f` | Scan→Query化(GSI監査) | 各モデルのGSI | **AWS_DEPLOYED** — 定義済みGSIが全てデプロイ済みであることを実測 |
| `39cce20` | LINE webhook/送信・Email(SES) | `/api/line/webhook` | **GIT_IMPLEMENTED_UNVERIFIED** — Secretが未設定のため実連携は未検証 |
| `8685b9a` | AI Gateway (Provider/Router/QualityGate/UsageLog) | `AIUsageLog` テーブル | **AWS_DEPLOYED** |
| `95c96d6` | 家財おまかせ便 送料importer | `ShippingRate`/`ShippingImportBatch` | **AWS_DEPLOYED** |

### デプロイ済みGSI(実測)

| テーブル | GSI |
|---|---|
| Inventory | `inventoriesByListingPartitionAndListUpdatedAt` / ByCategoryId / BySku / ByStatusId / ByLocationId / ByDeletedAt |
| ChannelListing | ByInventoryId / ByListingDraftId |
| ListingDraft | ByInventoryId |
| ImageProcessingVersion | ByImageStorageKey |
| Message | ByConversationId / ByExternalMessageId |
| Conversation | ByRelatedInventoryId / ByStatus |
| ProcessingJob | (GSIなし — 設計どおり) |

## 3. deploy成功によって初めて露出したruntime不具合

| # | 不具合 | 露出の順序 | 修正 |
|---|---|---|---|
| 1 | data ⇄ function 循環依存 | 最初のブロッカー。34本の失敗すべての原因 | `dd187e5` |
| 2 | `bello/line-channel-secret` AlreadyExists | ①を直して初めてCFNがリソース作成へ到達し露出 | `aeec16a` |
| 3 | worker Lambdaがsharpをロードできず INIT即死 | ②を直して初めてLambdaが実在し露出 | `4e6f235` |
| 4 | `/bello-system-icon.png` 404 | 実ページロードで測定 | `08ce2f2` |
| 5 | SSRロールがMercari/LINE Secret到達不能・Logs権限なし | IAM実測 | `1178d53` |

「1つ直すと次が出る」構造だったため、**①だけを直して成功と判断していたら
②③に到達できなかった**。

## 4. カーソルページネーション(P0-5)の正確な状態

`lib/inventory/inventoryCursorList.ts` は実装済みで、必要なGSIも
デプロイ済み。ただし **一覧の既定経路にはまだ接続されていない**
(`app/inventory/(protected)/page.tsx` は `listInventory` /
`listInventoryAdvanced` / `listInventorySimpleSearch` を呼ぶ)。
これはファイル冒頭コメントが挙げる3つの理由による意図的な保留であり、
未実装ではない。

その理由の1つ「バックフィル未実行」を本ラウンドで解消した:

| | 実行前 | 実行後 |
|---|---|---|
| `listingPartition` を持つレコード | 861 / 1,000 | **1,000 / 1,000** |
| カーソルGSI経由で引ける件数 | 861 | **1,000** |

`lib/inventory/listingPartitionBackfill.ts` と同一の意味の書き込み
(`listingPartition="ACTIVE"`、`listUpdatedAt` は既存 `updatedAt` を複製)
を139件へ適用。同ファイルが警告する「バックフィル自身が一覧の並び順を
押し上げる」不具合が起きていないことを実測で確認した——
**`listUpdatedAt` が `updatedAt` より新しいレコードは 0 件**。

なお `listUpdatedAt` が `updatedAt` より数十〜200ミリ秒だけ古いレコードが
24件あるが、これは不具合ではない: `listUpdatedAt` はアプリがcreate
ペイロード構築時に打刻し、`updatedAt` はAppSyncが書き込み時に打刻する
ための固有のずれで、秒単位で離れたレコード間の並び順には影響しない。

これで残る保留理由は「総件数を返さない」「"前へ"が1段分」の2つ
(どちらも設計上の意図的な制約)のみになった。

## 5. 陳腐化していた「未実装」記述の訂正

`AutoPricingSection.tsx` と `amplify/data/resource.ts` が §22 の
Pricing Scheduler を「未実装」と記していたが、実測では
`pricing-scheduler` はデプロイ済み・毎時稼働中だった。未実装なのは
**Mercariへの実価格送信のみ**(`handler.ts:173`、Mercariのupdate系
ミューテーションの実schema未確認のため §157「fake success禁止」に従い
実送信しない)。両ファイルのコメントを実測に合わせて訂正済み。

この種の陳腐化した記述は「既存実装を見落として作り直す」直接の原因に
なるため、発見次第訂正する方針とする。

## 6. 他branchに眠っている再利用候補

| branch | 未取込commit | 内容 |
|---|---|---|
| `claude/mercari-shops-auto-listing-ag0w6m` | 2 | Mercari Shops 自動出品 — 配送方法の動的取得、配送設定作成フロー、単体テスト。MASTER §30(出品field監査)/§37(Channel Adapter)の実装時に**作り直す前に参照すべき** |
| `claude/image-fetch-api-5r217s` | 2 | `zaico-verification/` — ZAICO APIの検証スクリプト(inventory_attachments endpoint 確認を含む) |
| `claude/new-session-me2dw3` | 1 | Amplifyバックエンド初期構築 + PWA初期案。**PWAは現行branchで完全に未実装**のため、着手時の出発点になり得る |

# 画像登録 AWS/Web Phase 1 実装前調査

## 実環境確認の追記（2026-09-16）

- AWS認証と実運用ADMINログインは現在有効。実リージョンは us-west-2。
- d4hkkg7dty2du（bello-inventory-staging）は公開成功した実運用先。branchは claude/inventory-management-system-5vbvc7 の1本のみ。DEVELOPMENTという表示だけでは試験環境とは扱わない。
- d1uy61lbnqm8ae（aws-amplify-system）は別stackだが、同branchのjob288（cd13975）は既存Secret名 bello/mercari-access-token の衝突でBUILD失敗、DEPLOY/VERIFY取消。利用可能な隔離stagingではない。自動修復・Secret変更・再デプロイは未実行。実運用先のjob281成功とは別の結果。
- したがって現時点で実データと分離された利用可能stagingを確認できていない。新権限適用や実データ書込をせず、先にローカル契約と合成試験を進める。実環境試験は、承認対象の権限差分とデータ分離方式を具体化してから行う。
- Claude Codeへの単発ローカル委任を実施。既存の停止中オーケストレーター/自動実行は再開しない。指示は PHOTO-PHASE1-CLAUDE-INSTRUCTIONS.md。

調査対象: 正本「自社システム画像登録機能.txt」全体、既存リポジトリ `work/gate-a` HEAD `cd13975285263fbf500a8fa7b90960b3f381a5d4`。ソース変更・AWS操作・データ変更は行っていない。これは設計判断用の調査であり、実装完了報告ではない。

## 結論と仕様内の整理

既存画像を残したまま、新しい撮影バッチ層を追加する。既存 Inventory.images への大量転記や一括移行は不要。既存の画像加工機能と今回のローカル加工済み画像の受入は別の入口とし、既存加工 worker へ自動投入しない。

- §80 の Phase 1 に §AA の最終必須条件を加える。§81 では Phase 2 とされる **Web追加upload** も AA に必須とあるため初期受入対象に含める。Listing画像順序保持も §90/AA に従い必須。
- バッチ全体のドラッグ並替え・主画像変更・解除・高度な監査UIは Phase 2 に分離可能。ただし論理削除、使用中削除防止、重要操作ログは初期から必要。§Z の削除復元試験には最小ADMIN復元操作を用意する。
- §70 の「asset.inventoryId不一致」は §4.6 の禁止と矛盾する。PhotoAsset に inventoryId を追加せず、BatchリンクとListing参照の整合性を検査する。
- §2 の region us-east-1 は現行環境の前提と異なる。既存接続設定を正とし移転しない。実環境の分離・リージョン確定は別途読取確認担当の記録に従う。
- §7/91 はサンプルのままでは processed/thumbnail の同一Asset対応、manifest固定、重複画像の予定数、追加upload時の予定数変更が未定義。実装前にAPI契約へ明記する（下記）。

## 現行17領域の確認（A-1 / §87）

|領域|現状・影響|
|---|---|
|1 Amplify全体|Gen2 `amplify/backend.ts` に auth/data/storage と複数Lambda、CDK権限配線。新規機能を独立Lambdaへ追加する構成が適合。|
|2 Data|`amplify/data/resource.ts` のモデル＋GSI。PhotoBatch/PhotoAsset/ListingImageSelection は未実装。既存モデルの削除・置換不要。|
|3 Storage|`belloInventoryStorage`。現行の明示ルールは inventory/*、knowledge/*。photo-batches/* は未許可。|
|4 Auth|email Cognito、Admins / ADMIN / EDITOR / VIEWER。PHOTO_DEVICE はない。既存グループを改名しない。|
|5 Inventory|Inventory ID、sku、statusId、画像配列。statusId GSIあり。画像用状態を追加する場合は optional photoStatus に限定、業務statusは変更しない。|
|6 既存画像|InventoryImage customType: storageKey/sortOrder、NORMAL/DAMAGE、isPrimary、thumbnailKey/mediumKey、sourceSystem/sourceUrl、originalHash/classification。旧フィールドを保持する。|
|7 詳細表示|`app/inventory/(protected)/[id]/page.tsx` → InventoryImageGallery。通常/傷画像を分離し resolveTopImage で主画像を決定。新画像は読取アダプタで合成し、旧配列へ保存しない。|
|8 Listing|ListingDraft.images は JSON `{storageKey, sortOrder}[]`、ChannelListing は別モデル。現状共通下書きの画像を使う構造。独立選択行を追加し旧下書きの読取を維持する。|
|9 出品画像|listing/page.tsx・ListingForm が在庫画像を表示、service.ts が下書き作成時に画像参照を初期化。新規選択・順序保存と既存CSV/ZIP画像取得へのアダプタが必要。再uploadを基本にしない。|
|10 bucket/prefix|手動画像は inventory/<uuid>、加工は inventory/processed・thumbnails、参照写真も inventory/photo-profile。新画像は photo-batches/{batchId}/{processed,thumbnail}/{assetId}.jpg。移動・public化・RAW lifecycle追加なし。|
|11 Role/Auth rule|DataはADMIN/EDITOR/VIEWER別認可。Storageでは複数所属時にAdminsの優先ロールが選ばれる既知事情あり。新しいprefixを既存inventory/*権限へ潜り込ませない。|
|12 API/Lambda|SKU custom mutation＋generate-sku Lambda等の先例。Data既定apiKeyとは別に在庫APIは userPool を明示。画像APIもCognito認証を必須にし、通常model CRUDによる不変条件の迂回を禁止する。|
|13 ナビ|主要左メニューは InventorySidebar ではなく `app/inventory/InventoryNavRail.tsx` の NAV_ITEMS。MobileBottomNav と共有。「画像登録」＋badgeを双方へ反映。|
|14 環境分岐|amplify.yml は AWS_BRANCH/AWS_APP_ID で backend pipeline-deploy。コード内の過去staging記述だけではデータ分離を証明できない。別環境の確認を必要条件とする。|
|15 migration/seed|既存の任意backfillスクリプト・UIあり。例 backfill-mercari-order-context は --dry-run 明示が必要な方式。今回は既存backfillを実行せず、新モデルのみ追加、合成fixtureを使用。|
|16 URL helper|useInventoryImageUrl、inventoryImageUrlResolver/cache、imageServerOps、CSV buildExportRows。保存するのはkeyのみ。新prefixへの署名URL取得と権限チェックを追加し、旧keyの経路は維持。|
|17 ログ|InventoryHistory、ImageProcessingVersion/ProcessingJob、各Lambda CloudWatch/console等がある。今回PhotoAuditLogに重要操作を記録、URL/tokenをログに含めない。既存画像監視とは責務を分ける。|

## 追加モデル・インデックス・権限案

- PhotoBatch: status/uploadedAt、inventoryId/linkedAt、localImportSessionId、expected/completed/failed、revision、cover、device/session/version情報。GSIは status+uploadedAt、inventoryId+linkedAt、sessionId。表示コード検索をScanなしにするなら batchCode 用の索引/決定的参照行も必要。
- PhotoAsset: batchId、sequence、processed/thumbnail keyとchecksum/size、clientAssetId、status、論理削除、processingVersion。inventoryIdなし。GSIは batchId+sequence、batchId+sha256Processed。
- ListingImageSelection: listingId+sequence、photoAssetId+listingId の索引。チャネル単位の listingId と共通下書きの関係を契約で固定する。旧画像参照は既存JSONを保持し、PhotoAssetを参照する新選択だけ独立行にする。
- PhotoIdempotency: session単位・batch内clientAssetId/hash単位の条件付き一意化。GSI検索後Createは禁止。決定的主キー＋条件Put/transactionで競合を保証。
- PhotoAuditLog: batchId+記録日時、inventoryId+記録日時。明示日時フィールドを使用（現行schemaの自動createdAtソートキー制約に注意）。
- 未登録badgeは status GSI Query のページ付きCOUNT等、初期は小さい集計キャッシュを使う。テーブルScanや全画像ダウンロードをしない。
- 新Lambdaのみ新テーブルの必要 Get/Put/Update/Query/transaction権限、既存Inventoryは存在確認のGet/候補Query中心。photoStatus更新を採用する場合はその限定更新を別に設計する。Listing保存との整合を保つ必要操作以外へ権限を広げない。
- S3権限は photo-batches/* の PutObject と GetObject（HEAD/署名GETを含む）に限定。DeleteObject/バケット操作/既存prefix変更は不要。ブラウザへの広い直接書込権限より署名URL発行経路に統一する。
- PHOTO_DEVICEはupload APIだけを許可する専用認可が必要。既存EDITORを端末用に流用するとInventory編集権限まで与えるため不可。追加グループ/専用クライアントなどの実環境変更は承認対象として提示する。固定AWSキーは使わない。

## APIで固定すべき契約

Cognito認証付き createPhotoBatch、requestPhotoAssetUploads（最大25件推奨）、completePhotoAssetUpload、completePhotoBatch、list/get、Inventory候補、link、logical-delete/restore、Listing選択保存。

processedとthumbnailは同じclientAssetId/photoAssetIdに帰属し、両方の期待checksum/byte数とupload URLを発行する。Asset complete は両方のHEADとchecksumを検証した時だけ一度カウント。finalizeは一貫したDB状態と固定manifestを検証し、再HEADしない。300枚はページ取得・25件chunkで処理し、300件transactionを作らない。

同一sessionの入力内容変更、同一clientAssetIdのhash変更はCONFLICT。同じbatch内hash重複は既存Assetを返すか明示SKIPし、manifest予定数は「重複除去後の枚数」として一致させる。READY後のWeb追加はrevision付きの追加manifestとして扱い、追加失敗中の既存確認済画像を消さない。

削除とListing選択の競合はGSI逆引きだけで保証しない（結果反映遅延がある）。参照カウンタ/条件transaction等で同時選択と削除を排他し、使用中は拒否。linkはBatchの未紐付け条件とInventory存在/未削除条件を一括検査。S3キーの上書き・別batch越境・署名URL期限切れ・DB更新失敗後再completeを試験する。

Inventory候補はstatusId GSIで50件ずつ。既存queries.tsの一覧・検索は全件取得フォールバックがあるため流用だけでScan禁止を満たしたとしない。SKU/IDの完全一致は既存index/Get、商品名・ブランド検索は既存検索索引の実装と充足状況を別途確認し、不足時は追加検索索引を設計する（全件バックフィルは実行しない）。

## 具体的変更ファイル案

1. `amplify/data/resource.ts`、`amplify/backend.ts`、必要に応じ `amplify/auth/resource.ts` / `storage/resource.ts`：加算モデル・カスタム操作・限定権限。
2. 新規 `amplify/functions/photo-registration/{resource,handler}.ts`、`lib/photoRegistration/{types,validation,service,repository,storage,apiContract}.ts`：純粋な状態判定とAWS入出力を分離。
3. 新規 `app/actions/photoRegistration.ts`、`app/inventory/(protected)/photo-registration/page.tsx` と `[batchId]/page.tsx`、画像グリッド/在庫候補UI。
4. `app/inventory/InventoryNavRail.tsx`、`MobileBottomNav.tsx`：メニュー/badge。
5. 詳細 `[id]/page.tsx`、必要なら `InventoryImageGallery.tsx` とURL helper：既存＋新画像の読取統合。編集・削除は保存層ごとに分ける。
6. listing/page.tsx・ListingForm.tsx、`lib/listing/{types,service}.ts`、`app/actions/listing.ts`、`lib/listing/mercari/csv/buildExportRows.ts`：選択保存・順序・CSV/ZIPの互換。
7. 新規 scripts/verify-photo-registration-*、e2e/photo-registration.spec.ts、docs/photo-registration-api-v1.md：合成試験、実API契約、復旧手順。readonly整合性監査も新規作成し本番実行を自動化しない。

## 実装順序・検証・不足前提

状態/冪等性/manifest契約 → 合成repository試験 → 新モデル/権限差分の静的確認 → upload API → 一覧/詳細/追加/削除 → link → 商品詳細 → Listing → staging実結合の順。Photo Station仕様編集・実装は実API契約の確定後。

試験は0/1/20/100/300枚、同時create/complete/link/選択と削除、同hash再送、通信断/再起動、S3成功DB失敗/逆、論理削除復元、追加batch、既存画像/EC/CSV保持。stagingでは実S3 PUT/HEAD・Cognito各権限・20枚全操作と300枚finalizeを確認し、公開bucketなし/Scanなしを証拠化する。

不足前提は実際に隔離されたstaging、そこで使用できるADMIN/端末認証、対象bucket/prefix・CORS・Lambda権限の承認範囲。現在の予算台帳2テーブル限定承認は画像機能のIAM追加を含まない。実環境へのIAM拡張前に停止する。認証/MFAの本人操作が必要かは長時間実装前にまとめて確認する。

これらが未確定でも、ローカルの契約/純粋ロジック/モックUI/合成試験は安全に進められる。既存画像の移行・削除、RAW Lifecycle、手動ZAICO同期、本番テストデータ投入は不要で実行しない。追加モデルは加算型で破壊的migration不要だが、実AWS適用時のIAM/S3/Cognito差分とstaging分離を確認するまではstaging完了とは報告しない。

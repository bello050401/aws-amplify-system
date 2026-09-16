# 画像登録基盤 Phase 1 — デプロイ差分計画 (未適用)

> **この文書に記載された変更は一切適用されていない。** `amplify/backend.ts` の
> `defineBackend({...})` には今回追加していない。`ampx sandbox` /
> `ampx pipeline-deploy` はこの文書のリソースを何も作らない。既存の
> `amplify/data/resource.ts` / `amplify/auth/resource.ts` /
> `amplify/storage/resource.ts` は未変更。

対象: `lib/photoRegistration/{ports,keys,auth,awsRepository,awsStorage,service}.ts`、
`amplify/functions/photo-registration/{resource,handler}.ts` (候補実装、未接続)。
契約正本: `docs/photo-registration-api-v1.md`。正本仕様書: `docs/photo-phase1-source/自社システム画像登録機能.txt`。

## 1. このタスクの範囲

正本の目的 (AWS/Web画像登録機能) のうち、**永続化/API層のみ**を実行可能な形で用意した。
Web UI (§9-§21, §41-§46)・Photo Station本体・AppSync schemaへの実接続・実デプロイは対象外。

実装したもの:

- `lib/photoRegistration/ports.ts` — 永続化ポート (インターフェースのみ、AWS非依存)。
- `lib/photoRegistration/keys.ts` — DynamoDB単一テーブル設計のキー生成 (純粋)。
- `lib/photoRegistration/auth.ts` — 信頼済みCognito claims → role → operation許可の判定。
- `lib/photoRegistration/awsRepository.ts` — 実際のDynamoDB SDK (TransactWriteCommand等) アダプター。
- `lib/photoRegistration/awsStorage.ts` — 実際のS3 SDK (presigned PUT / HeadObject) アダプター。
- `lib/photoRegistration/service.ts` — 上記を束ねる実行可能サービス層 (限定retry込み)。
- `amplify/functions/photo-registration/{resource,handler}.ts` — Lambda候補 (未接続)。
- `scripts/verify-photo-registration-api.ts` — 外部IOのみ偽装した合成試験。

既存の `lib/photoRegistration/{types,validation,state}.ts` (前工程で実装済みの契約・純粋関数層) は変更していない。

## 2. 追加が必要なAWSリソース (すべて未適用)

### 2.1 DynamoDBテーブル (新規、単一テーブル設計)

物理名の例: `PhotoRegistration-<env>` (現行の他リソースの命名慣行 — `amplify/backend.ts` の
`SkuCounterTable`/`PriceExecutionLogTable` と同様の生CDK `Table` として追加する想定)。

- パーティションキー `PK` (String) / ソートキー `SK` (String)。
- GSI1: `GSI1PK` / `GSI1SK` — 未登録一覧 (`byStatusUploadedAt`, 契約§4.5)。
- GSI2: `GSI2PK` / `GSI2SK` — Inventory別一覧 (`byInventoryLinkedAt`)。
- BillingMode: PAY_PER_REQUEST (他の新規テーブルと同じ判断)。
- RemovalPolicy: RETAIN (画像登録履歴を失うと商品とS3の対応関係が分からなくなる — `PriceExecutionLogTable` と同じ理由)。
- PITR: 有効化を推奨 (正本§52)。CDKでの明示設定が必要 (未着手)。

キー規則の全量は `lib/photoRegistration/keys.ts` を正とする。実体は以下の通り:

| エンティティ | PK | SK | GSI1 | GSI2 |
|---|---|---|---|---|
| PhotoBatch | `BATCH#<id>` | `BATCH#<id>` | `BATCH_STATUS#<status>` / `<uploadedAt>#<id>` | `BATCH_INVENTORY#<inventoryId>` / `<linkedAt>#<id>` (link後のみ) |
| PhotoAsset | `BATCH#<batchId>` | `ASSET#<seq6>#<assetId>` | (無し) | (無し) |
| 冪等ガード (session) | `SESSION#<sessionId>` | 同左 | — | — |
| 冪等ガード (clientAssetId) | `BATCH#<batchId>` | `ASSETIDX#CLIENT#<clientAssetId>` | — | — |
| 冪等ガード (sha256) | `BATCH#<batchId>` | `ASSETIDX#HASH#<sha256>` | — | — |
| Listing選択状態 | `LISTING#<listingId>` | `SELECTION_STATE` | — | — |
| Listing選択行 | `LISTING#<listingId>` | `SELECTION_ROW#<seq3>#<assetId>` | — | — |

`photoAssetId` はキー設計上の理由で `<batchId>#A#<ulid>` の形で採番する
(`keys.ts` 冒頭コメント参照 — `completePhotoAssetUpload`/`deletePhotoAsset`/
`restorePhotoAsset` の入力が `photoAssetId` のみで `batchId` を含まないため、
逆引き用GSIを増やす代わりにIDへ埋め込む設計判断)。

### 2.2 S3

既存 `amplify/storage/resource.ts` のバケットは変更しない。以下のいずれかを選ぶ必要がある
(未決定、要ユーザー判断):

- **案A (推奨)**: 既存バケットへ新規prefix `photo-batches/*` を追加するだけで済ませる。
  既存の `inventory/*` prefixとは完全に分離されており (契約§2.1)、既存画像の参照経路に
  一切干渉しない。既存Storage定義への追加権限 (`photo-batches/*` に限定したPUT/GET/HEAD)
  で足りる。
- **案B**: 画像登録専用の新規バケットを切る。既存バケットのライフサイクル/CORS設定に
  影響を与えたくない場合の選択肢。

いずれの案でも:

- Public read禁止。presigned PUT/GET/HEADのみ。
- DeleteObject権限は付与しない (§12: 論理削除のみ、物理削除は将来の明示的ジョブ)。
- CORS: Photo Station / 管理画面の実オリジンのみ許可 (`*` にしない、§76)。
- Versioning有効化を推奨 (§52、誤削除対策)。CDKでの明示設定が必要 (未着手)。
- RAW用のLifecycle Ruleは導入しない (§6、Phase 1範囲外)。

### 2.3 Cognito

- 新規group `PHOTO_DEVICE` を `amplify/auth/resource.ts` の `groups` 配列へ追加する必要がある。
  既存 `ADMIN`/`EDITOR`/`VIEWER` の流用は不可 (EDITORはInventory編集権限まで持つ、契約§5)。
- `lib/photoRegistration/auth.ts` の `resolveActorContext` は `AuthConfig.photoDeviceGroupDeployed`
  が `true` にならない限りPHOTO_DEVICE roleを一切許可しない (fail closed) —
  この値は `amplify/functions/photo-registration/handler.ts` の環境変数
  `PHOTO_DEVICE_GROUP_DEPLOYED` から注入する想定で、**上記group追加が実際にデプロイされ、
  端末アカウントが作成されるまで `"true"` を設定してはならない**。
- Photo Station専用ユーザーには `custom:deviceId` カスタム属性の追加を推奨
  (`handler.ts` の `toTrustedClaims` が読む。§25.1「端末専用ユーザー」に対応)。
  未設定の場合、`assertDeviceOwnsBatch` (auth.ts) は当該端末をどのbatchにも
  所属させない (常に拒否) — これもfail closed側に倒れる。
- 固定AWS Access KeyをPhoto Station (Windows) へ埋め込むことは引き続き禁止 (§25.1)。
  実際の認証方式 (User Pool + Identity Pool経由の一時credential等) は本タスクの範囲外。

### 2.4 IAM (Lambda実行ロールへの最小権限)

`amplify/backend.ts` の既存パターン (`backend.data.resources.tables[...].grantReadWriteData(fn)`)
に倣う。**今回は一切付与していない。** 実接続時に必要な差分:

- 新規PhotoRegistrationテーブル: `grantReadWriteData(photoRegistrationLambda)`。
- 既存 `Inventory` テーブル (`backend.data.resources.tables["Inventory"]`): **read-onlyのみ**
  (`grantReadData`)。§4.6により画像登録層はInventory本体を一切書き換えない —
  `lib/photoRegistration/awsRepository.ts` の `lookupInventory` はGetItemしか行わない。
- S3 (案Aの場合): `backend.storage.resources.bucket.grantPut(fn, "photo-batches/*")` +
  `grantRead(fn, "photo-batches/*")`。`grantDelete` は付与しない。
- Cognito: Lambda自体はCognitoへのIAM権限を必要としない (claimsはAppSyncが検証済みで渡す前提)。

### 2.5 AppSync / GraphQL schema

未着手。`amplify/data/resource.ts` へ以下は**追加していない**:

- `PhotoBatch` / `PhotoAsset` / `ListingImageSelection` の型定義 (Amplify `a.model()` は
  通常CRUDを自動生成してしまうため、契約が要求する条件付き遷移・冪等性・300枚境界を
  素通りできてしまう。正本§72の指示通り、これらはカスタムmutation/queryとして
  `amplify/functions/photo-registration/handler.ts` のようなLambda direct resolver
  経由に限定し、**通常のmodel CRUD (create/update/delete) は公開しない**設計とすること)。
- カスタムmutation: `createPhotoBatch` / `requestPhotoAssetUploads` /
  `completePhotoAssetUpload` / `completePhotoBatch` / `linkPhotoBatchToInventory` /
  `deletePhotoAsset` / `restorePhotoAsset` / `setListingImageSelection`。
- カスタムquery: `listUnregisteredBatches` / `listBatchesForInventory`。
- 認可: `allow.group(["PHOTO_DEVICE","EDITOR","ADMIN"])` 等をoperationごとに絞る
  (`lib/photoRegistration/auth.ts` の `ALLOWED_ROLES` と一致させること — 二重に強制する
  ことで、AppSync層の設定ミスだけに権限を依存させない)。

## 3. amplify/backend.ts へ実際に接続する際の手順 (未実施)

1. `amplify/functions/photo-registration/resource.ts` の `photoRegistration` を
   `defineBackend({...})` へ追加。
2. PhotoRegistrationテーブルを生CDK `Table` として `backend.createStack(...)` 配下に追加し、
   GSI1/GSI2を `addGlobalSecondaryIndex` で定義。
3. `photoRegistrationTable.grantReadWriteData(backend.photoRegistration.resources.lambda)`。
4. `backend.data.resources.tables["Inventory"].grantReadData(backend.photoRegistration.resources.lambda)`。
5. S3 (案A) なら `backend.storage.resources.bucket.grantPut/grantRead(..., "photo-batches/*")`。
6. 環境変数: `PHOTO_REGISTRATION_TABLE_NAME` / `INVENTORY_TABLE_NAME` /
   `PHOTO_REGISTRATION_BUCKET_NAME` / `PHOTO_DEVICE_GROUP_DEPLOYED` を
   `backend.photoRegistration.addEnvironment(...)` で設定。
7. `amplify/auth/resource.ts` の `groups` へ `"PHOTO_DEVICE"` を追加し、端末アカウントを作成。
8. AppSync schemaへカスタムmutation/queryを追加し、Lambda direct resolverとして
   `backend.photoRegistration` を紐付け。
9. staging環境で `scripts/verify-photo-registration-api.ts` が保証していない範囲
   (実DynamoDB条件付き書込み・実S3 presigned URL・実Cognito認可) を受け入れ試験する。

この手順のいずれも今回実行していない。

## 4. 既知の未実装・限界 (Phase 2以降、または要追加実装)

- **PhotoAuditLog**: 正本§81でPhase 2扱い。今回未実装 (テーブル・書込みとも無し)。
- **紐付け解除 / 別商品への付け替え (§27)**: Phase 2。`decideLinkBatchToInventory` に対応する
  `unlink` decisionは未実装。
- **並び替え (§15) / メイン画像設定 (§23) / ダウンロード (§14) / 再加工 (§35)**: 未実装 (Phase 2/3)。
- **MAX_ASSETS_PER_BATCH (300件) の絶対境界**: `docs/photo-registration-api-v1.md` §4 補足に
  ある既知の限界がそのまま残る — `requestPhotoAssetUploads` の300件上限は
  `registeredAssetCount <= planLimit - created` の条件で実質的に閉じているが
  (`planLimit` は `expectedAssetCount` に連動し、`expectedAssetCount` 自体は
  createPhotoBatch/revision/delete/restoreでのみ動くため、300を超える`expected`は
  作れない)、「論理削除されていないAsset実数」を直接数える独立したTransactWriteItems
  条件としては持たせていない。実運用でこの2つの値が乖離しないことは
  `scripts/verify-photo-registration-api.ts` の合成試験の範囲では確認できるが、
  実DynamoDBでの長期運用による検証は未実施。
- **Web追加upload (PNG/WebP) のS3キー拡張子**: `service.ts` の
  `completePhotoAssetUpload` は `asset.declared[variant].mimeType` からS3キーの拡張子を
  再構成する (`extensionForMimeType`) — `requestPhotoAssetUploads` 時点の宣言と
  一致している限り正しいが、これは今回のS3キー設計の前提 (§5「拡張子はvariantによらず
  jpg、PNG/WebPを受ける場合のみ拡張子が変わる」) に依存している。
- **`setListingImageSelection` とAppSyncの接続**: `service.ts` はこの操作に
  `listingInventoryId` (呼び出し側が既存Listing/ChannelListingモデルから引いた値) を
  明示的な引数として要求する。`amplify/functions/photo-registration/handler.ts` は
  単一のLambda direct resolverではこの値を解決できないため、この1操作だけは
  意図的に未接続のままにしてある (`handler.ts` のdispatchコメント参照)。
  実接続時はAppSync pipeline resolver、またはNext.js server actionから
  `service.ts` を直接呼ぶ経路のいずれかを選ぶ必要がある (要判断)。
- **CancellationReasonsの精密なエラー分類**: `awsRepository.ts` の
  `applyLink`/`applyRequestUploads` 等は、TransactWriteItemsが複数条件を同時に
  持つ場合、実際にどのitemの条件が破れたかを`CancellationReasons`から精密に
  判別せず、`decision.conditions[0]`の`violationError`を代表値として返している。
  境界試験 (`scripts/verify-photo-registration-api.ts` の「decide後・commit前に
  Inventoryが削除された」試験) では「条件付き書込みが拒否されること」自体は
  確認しているが、返るエラーコードが必ずしも最も適切な1つとは限らない
  (例: INVENTORY_NOT_FOUNDになるべき場面でBATCH_ALREADY_LINKEDが返り得る)。
  `CancellationReasons[i].Code`を`TransactItems`のインデックスと対応付けて
  精密化するのはPhase 2の改善候補。

## 5. 安全性の確認 (今回の変更範囲内)

- 既存 `amplify/data/resource.ts` / `amplify/auth/resource.ts` / `amplify/storage/resource.ts` /
  `amplify/backend.ts` は無変更 (grep差分ゼロ)。
- 既存Inventory/Listingへの書き込みコードは一切追加していない
  (`awsRepository.lookupInventory` はGetItemのみ)。
- 本番デプロイ・DynamoDB migration・IAM適用・Cognito group追加は実行していない
  (このファイルへの記載のみ)。

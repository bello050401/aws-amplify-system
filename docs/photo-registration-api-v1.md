# 画像登録 API 契約 v1-draft（未デプロイの候補）

> **レビュー未通過・実APIとして採用禁止（2026-09-16）**。初回レビューで指摘された、固定予定枚数(expectedAssetCount)、finalize/link/追加uploadの競合条件、Listing選択revision、restoreの認証/所属確認、actorUserId等の信頼境界の9項目、および再審査で指摘された (1) `requestPhotoAssetUploads` の `sourceType` を信頼済み認証コンテキストから受け取る契約への直接呼出し側の追従、(2) hash一意化試験のfixture不備、(3) 本ファイルの記載同期、(4) 追加upload revision後も `createPhotoBatch` の同一セッション再送を `expectedAssetCount` の不変な初回値で判定する契約、の4項目は `lib/photoRegistration/{types,validation,state}.ts` と本ファイル・合成試験の範囲で修正済み。ただし修正後の合成試験・型検査は本レビュー担当（Claude）自身は実行しておらず、ホストのIndependentVerifierによる実行結果を待つ状態である。DynamoDB/S3/Cognito側の原子性・実在確認・権限は引き続き完全に未実装・未検証。以下は保全用草稿であり、AWS実装・Photo Stationの契約正本にしてはいけない。

対象: 正本「自社システム画像登録機能.txt」(v3.0 Final Draft) Phase 1 のうち、**AWSへ変更を加えずに確定できる API 契約と状態遷移**。
実装: `lib/photoRegistration/{types,validation,state}.ts`、合成試験 `scripts/verify-photo-registration-contract.ts`。
基点コミット: `cd13975285263fbf500a8fa7b90960b3f381a5d4`。調査書: `outputs/PHOTO-PHASE1-PREIMPLEMENTATION.md`。

## 0. この文書の位置づけ（先に読むこと）

- ここに書かれた operation / 型 / エラーは **未デプロイの候補 (candidate, `v1-draft`)** である。AppSync schema・Lambda・DynamoDB テーブル・GSI・IAM・S3 prefix・Cognito group のいずれも **まだ存在しない**。
- したがって Photo Station 側は、この契約を**確定仕様として実装を開始してはならない**。用途は「AWS 側実装の設計入力」と「将来の接続仕様のたたき台」。
- ローカルの合成試験が通ることは、**冪等性・競合防止・S3 完全性が AWS 上で成立していることを一切証明しない**（§7）。
- region は現行の `us-west-2`（`amplify_outputs.json`）。正本 §2 の `us-east-1` は採用しない。既存 bucket・既存画像は移転しない。
- 既存の `inventory/*` prefix、`Inventory.images`、`ListingDraft.images` には触れない。新旧併存（正本 §37 選択肢C）。

## 1. 共通事項

| 項目 | 内容 |
|---|---|
| 認証 | Cognito User Pool（必須）。Photo Station は端末専用ユーザー＋専用グループ想定。長期固定 AWS アクセスキーは使わない（§25.1）。**未実装・未承認** |
| 転送 | 画像バイナリは API を通さない。S3 への presigned PUT 直送（§73） |
| 契約バージョン | `PHOTO_REGISTRATION_CONTRACT_VERSION = "v1-draft"`。リクエストには `clientVersion` を添える（§60） |
| 最大枚数 | 1 batch あたり論理削除されていない PhotoAsset **300 件**（`MAX_ASSETS_PER_BATCH`） |
| chunk | `requestPhotoAssetUploads` は 1 回 **1〜25 件**（`MAX_UPLOAD_REQUEST_CHUNK`、§7.5 推奨A） |
| サイズ上限 | processed 25MB / thumbnail 2MB（§75） |
| MIME | processed: Photo Station は `image/jpeg` のみ、Web 追加 upload は `image/jpeg|image/png|image/webp`。thumbnail は常に `image/jpeg`（§74） |
| checksum | `sha256` は**小文字 hex 64 桁**のみ。大文字は自動変換せず拒否（冪等キーの一意性を壊さないため） |
| original / RAW | Phase 1 では AWS へ送らない（§6）。契約にも存在しない |

### 1.1 信頼境界（実行主体・sourceType）

- **`actorId` / `role` はクライアントの request body から受け取らない。** 認証済みサーバーコンテキスト（Cognito claims）から `PhotoActorContext { actorId, role }` として作る（`types.ts`）。クライアントが自分を `ADMIN` と名乗れてはいけない。
- **`sourceType`（`PHOTO_STATION` / `WEB_UPLOAD`）もクライアントの申告ではなく、認証済み `role` から `sourceTypeForActor(role)` で導出する。** `requestPhotoAssetUploads` の入力検証 `validateRequestUploadsInput(input, sourceType)` は、この導出済み `sourceType` を**第 2 引数（独立した信頼済み値）として必須で受け取る**。request body に同名フィールドがあってもそれは読まない。
- `Validated*` 型（`localImportSessionId` / `batchId` / `photoAssetId` など、クライアント入力由来の値のみ）と `PhotoActorContext`（サーバー由来）は型として意図的に分離している。純粋関数の引数のうち、どこまでが「外部 request の入力」でどこからが「サーバーが注入する内部情報」かをこの分離で明示する。

### 1.2 エラーコードとリトライ可否

| code | 意味 | クライアントの再送 |
|---|---|---|
| `AUTH_REQUIRED` / `PERMISSION_DENIED` | 認証・認可 | 不可（資格情報を直す） |
| `INVALID_INPUT` | 形式不正（型・範囲・MIME・checksum 形式・chunk 内重複） | 不可（同じ入力では必ず同じ結果） |
| `CHUNK_TOO_LARGE` | 26 件以上 | 25 件以下に割って再送 |
| `ASSET_LIMIT_EXCEEDED` | 300 枚超過 | 不可（別 batch にする） |
| `BATCH_NOT_FOUND` / `ASSET_NOT_FOUND` | 対象なし | 不可 |
| `IDEMPOTENCY_CONFLICT` | 同じ冪等キーで**異なる内容** | 不可（キーか内容を直す） |
| `CONFLICT` | 条件付き書込みが競合 / manifest の食い違い | **読み直してから**再送 |
| `UPLOAD_NOT_COMPLETE` | S3 未着・サイズ不一致・checksum 取得不能 / 完了枚数不足 | 可（upload をやり直す・待つ） |
| `HASH_MISMATCH` | 宣言 sha256 と実物が違う | 可（正しいファイルを再 upload） |
| `INVALID_STATUS_TRANSITION` | 状態上できない操作 | 不可 |
| `BATCH_ALREADY_LINKED` | 既に在庫へ紐付け済み | 不可（UI で解除を促す） |
| `EMPTY_BATCH` | 0 枚の batch を確認待ちにしようとした | 不可（ARCHIVED で破棄） |
| `ASSET_IN_USE` | 出品で使用中の画像の削除 | 不可（先に出品から外す） |
| `ASSET_NOT_DELETED` | 削除されていない画像の復元 | 不可 |
| `CHANNEL_IMAGE_LIMIT_EXCEEDED` | チャネル上限超過 | 不可 |
| `INVENTORY_NOT_FOUND` | 在庫なし | 不可 |
| `INTERNAL_ERROR` | 想定外 | 可（指数バックオフ） |

`message` は管理者・ログ向けであり、そのままエンドユーザーへ出さない（§49）。

## 2. データモデル（契約に現れる範囲）

- **PhotoBatch** — 1 回の SD 取込 = 1 商品（§1.2）。`inventoryId` を持つ唯一のモデル。
- **PhotoAsset** — 画像 1 枚。**`inventoryId` を持たない**（§4.6）。1 Asset が `PROCESSED` と `THUMBNAIL` の 2 オブジェクトを持つ。
- **ListingImageSelection** — 出品ごとの画像選択（`listingId`, `photoAssetId`, `sequence`, `isPrimary`）。既存 `ListingDraft.images` とは別行。

### 2.1 S3 キー（登録後も不変、§1.3 / §5 / §54）

```
photo-batches/{batchId}/processed/{assetId}.jpg
photo-batches/{batchId}/thumbnail/{assetId}.jpg
```

商品名・ブランド・在庫 ID・日本語を含めない。在庫へ紐付けても **移動・コピーしない**。DB に presigned URL を保存しない（§53）。

### 2.2 manifest の不変条件（§7.6 / §13）

PhotoBatch は `expectedAssetCount` / `originalExpectedAssetCount` / `registeredAssetCount` / `completedAssetCount` / `failedAssetCount` / `revision` / `openRevision` を持つ。

- **`expectedAssetCount` は `createPhotoBatch` で固定する、この取込で登録する予定枚数（重複除去後）。** `requestPhotoAssetUploads` では増えない。「300 枚予定で 25 枚しか送れていない」状態が `expected=25` として完結し、不足が表示できなくなることを防ぐための固定値。増えるのは追加 upload（§13）で revision を開く時と、復元（減るのは論理削除）だけ。
- **`originalExpectedAssetCount` は `createPhotoBatch` で最初に固定した値そのもので、revision・論理削除・復元があっても変わらない不変値。** 同一 `localImportSessionId` の再送が「元の create 要求そのもの」であることを、`expectedAssetCount`（revision で変動する）ではなくこの不変値と比較して判定する（§3.1）。
- `registeredAssetCount` は `requestPhotoAssetUploads` で受理済み（重複除去後）の Asset 数。**「完了数」とは別物** — `finalize` は `registered == expected && completed == expected` の両方を要求する。
- `completedAssetCount` は **S3 検証を通った** Asset 数。クライアントの申告では増えない。
- `READY_FOR_REVIEW` / `LINKED` の維持へ進める条件は `registered == expected && completed == expected && failed == 0`（§29）。
- **この等式は「常に成り立つ不変条件」ではなく finalize の事前条件**。追加 upload（§13）で `expected` が先に増えるため。
- 論理削除は `expected` と `registered`、対象の状態に応じて `completed` / `failed` を**同時に**減らす。復元は逆に増やす。一部だけ増減すると等式が二度と成立せず、以後の finalize が通らなくなる。
- **追加 upload（§13）は `openRevision: { revision, expectedDelta }` を開く操作として表現する。** `READY_FOR_REVIEW` / `LINKED` の batch へ新規 Asset を追加する最初の `requestPhotoAssetUploads` は `additionalExpectedCount`（追加予定枚数、開始時に固定）を必須で送る。`openRevision` が開いている間の再送は、同じ `additionalExpectedCount` なら冪等に受理し revision を二重に開かない／`expected` を二重加算しない。異なる値の再送は `CONFLICT`。`finalize` が `openRevision` を閉じるまで `link` はできない（`UPLOAD_NOT_COMPLETE`）。
- **`LINKED` の batch への追加 upload の完了は `LINKED` を維持する。** `READY_FOR_REVIEW` へ戻さない — 戻すと紐付け済みの batch が未登録一覧へ復活し、紐付けが消えたように見える。

### 2.3 状態遷移（§33）

```
CREATED          -> UPLOADING | ARCHIVED | ERROR
UPLOADING        -> READY_FOR_REVIEW | ERROR
READY_FOR_REVIEW -> LINKED | ARCHIVED | ERROR
LINKED           -> ARCHIVED
ERROR            -> UPLOADING | ARCHIVED     （§28 再開。自動削除はしない）
ARCHIVED         -> （出口なし）
```

`LINKED -> UPLOADING` は禁止。**追加 upload はこの表を使わない** — status を戻すと確認済みの READY 画像がレビュー対象から外れるため、`openRevision` を開く方式にする（§4）。

PhotoAsset: `UPLOADING -> READY | FAILED`、`* -> DELETED`（論理削除）、`DELETED -> 削除前の状態`（復元）。

## 3. Operations

### 3.1 `createPhotoBatch`

```jsonc
// input
{ "localImportSessionId": "DESKTOP01-SD02-20260916T103200",
  "sourceDeviceId": "BELLO-PHOTO-PC-01", "sourceSdCardId": "SD-A",
  "imageCountOriginal": 24, "expectedAssetCount": 24, "clientVersion": "1.0.0" }
// output
{ "batchId": "...", "batchCode": "PHOTO-20260916-0001", "status": "CREATED" }
```

- 冪等キー: `localImportSessionId`（決定的キー `SESSION#<id>`）。
- 同じ sessionId の再送は **新しい batch を作らず既存を返す**（§30）。
- 同じ sessionId で `sourceDeviceId` / `sourceSdCardId` が違えば `IDEMPOTENCY_CONFLICT`。`clientVersion` の差は許容（再送中に Photo Station が更新され得るため）。
- `imageCountOriginal` はローカルが検出した差分の**原本**枚数の記録であり、manifest の `expectedAssetCount` ではない。finalize の判定には使わない。
- **`expectedAssetCount` は必須。0〜300、かつ `imageCountOriginal` を超えてはならない**（重複除去後の枚数が原本より増えることはない）。ここで固定した値が `originalExpectedAssetCount` / `expectedAssetCount` として保存され（§2.2）、`requestPhotoAssetUploads` では増えない。
- **同じ sessionId で `expectedAssetCount` が違えば `IDEMPOTENCY_CONFLICT`。** 比較対象は現在の `expectedAssetCount`（revision で増減し得る）ではなく `originalExpectedAssetCount`（作成時の不変値）。したがって追加 upload revision を経た batch へ、Photo Station が元の `createPhotoBatch` 要求（作成時と同じ値）を再送しても正しく既存 batch を返す。作成時と異なる値（revision 後の現在値を含む）を送れば拒否する。
- 0 枚の作成要求自体は受理する（`expectedAssetCount=0`）。0 枚のまま finalize すると `EMPTY_BATCH`（§79）。

### 3.2 `requestPhotoAssetUploads`

```jsonc
// input（assets は 1〜25 件。sourceTypeはbody に含めない — §1.1 の信頼境界を参照）
{ "batchId": "...",
  // READY_FOR_REVIEW / LINKED の batch へ新規 Asset を追加し revision を開く最初の
  // 要求だけ必須。通常の初回 upload では省略 (null)。
  "additionalExpectedCount": null,
  "assets": [{ "clientAssetId": "SD-A#DSC01234",
               "fileName": "DSC01234.JPG",
               "processed":  { "mimeType": "image/jpeg", "fileSize": 1240000, "sha256": "<64hex>" },
               "thumbnail":  { "mimeType": "image/jpeg", "fileSize": 40000,   "sha256": "<64hex>" } }] }
// output
{ "batchId": "...", "revision": 0,
  "items": [{ "kind": "CREATE_ASSET", "clientAssetId": "...", "photoAssetId": "...",
              "uploads": [{ "variant": "PROCESSED", "s3Key": "...", "uploadUrl": "...",
                            "expectedBytes": 1240000, "expectedMimeType": "image/jpeg",
                            "expectedSha256": "<64hex>" },
                          { "variant": "THUMBNAIL", "...": "..." }] }] }
```

`sourceType`（`PHOTO_STATION` / `WEB_UPLOAD`）は request body ではなく、AppSync resolver が認証済み `role` から `sourceTypeForActor(role)` で導出し、`validateRequestUploadsInput(input, sourceType)` へ第 2 引数として渡す（§1.1）。

**processed と thumbnail は同一 PhotoAsset に属する。** 正本 §7.2 のサンプルは 1 オブジェクト＝1 要求に見えるが、そのままでは thumbnail が別 Asset として二重計上され manifest が合わない。よって Asset 単位で両方の署名 URL を同時に発行し、**両方の検証が通った時だけ 1 件**として READY 計上する。

`items[].kind` の 4 種:

| kind | 条件 | 意味 |
|---|---|---|
| `CREATE_ASSET` | 未知の clientAssetId・未知の hash | 新規。`registered` +1（`expected` は revision を開く時だけ動く） |
| `REISSUE_UPLOAD` | 同一 clientAssetId・同一 hash・まだ READY でない | 通信断後の再送。**同じ photoAssetId・同じ S3 キー**へ URL を再発行。`expected` / `registered` 増減なし |
| `ALREADY_READY` | 同一 clientAssetId・同一 hash・既に READY | 完了済み。**URL を発行しない**（検証済み S3 オブジェクトの上書きを防ぐ） |
| `DUPLICATE_SKIP` | batch 内に同一 `sha256Processed` の別 Asset | §31 の重複。既存 Asset を返す。`expected` は増えない |

拒否:

- 同一 `clientAssetId` で **hash が変わった**再送 → `IDEMPOTENCY_CONFLICT`（S3 の既存オブジェクトを別画像で上書きでき、検証済みの completed が嘘になるため）。
- 削除済み Asset の `clientAssetId` の再利用 → `IDEMPOTENCY_CONFLICT`（復元 API を使う）。
- chunk 内での `clientAssetId` 重複 / `sha256` 重複 → `INVALID_INPUT`（送信側の自己矛盾。どちらへ紐づけるか決められない）。
- 301 件目（論理削除されていない Asset 数、§12 参照）→ `ASSET_LIMIT_EXCEEDED`。
- **`registeredAssetCount` が予定枚数（`expectedAssetCount` ＋ 進行中 revision の `additionalExpectedCount`）を超える受理 → `ASSET_LIMIT_EXCEEDED`。** `expectedAssetCount` は `createPhotoBatch` で固定済みで、通常の `requestPhotoAssetUploads` では増えない（§2.2）。「300 枚予定で 25 枚しか送れていない」状態を `expected=25` として完結させない。
- `READY_FOR_REVIEW` / `LINKED` の batch への**新規 Asset 追加は `sourceType=WEB_UPLOAD` のみ**（§13）。Photo Station からの新規追加は `INVALID_STATUS_TRANSITION`。既知 Asset の再送は確認済み batch でも通る。
- **追加 upload で新規 revision を開く最初の要求は `additionalExpectedCount` が必須**（未指定は `INVALID_INPUT`）。開始時にその revision の追加予定枚数を固定する操作であり、固定しないと「いつ揃ったか」を判定できない。
- **開いている revision への再送で `additionalExpectedCount` が既存の `openRevision.expectedDelta` と異なれば `CONFLICT`。** 同じ値の再送は revision を二重に開かず・`expected` を二重加算しない冪等な受理。
- `ARCHIVED` の batch → `INVALID_STATUS_TRANSITION`。

`CREATED`（または `ERROR`）の batch に新規 Asset が入った時点で `UPLOADING` へ遷移する。

### 3.3 `completePhotoAssetUpload`

```jsonc
// input
{ "photoAssetId": "...",
  "processed": { "sha256": "<64hex>", "fileSize": 1240000, "width": 3000, "height": 2000 },
  "thumbnail": { "sha256": "<64hex>", "fileSize": 40000,  "width": 400,  "height": 267 },
  "processingVersion": "lightroom-v1" }
// output
{ "photoAssetId": "...", "status": "READY" }
```

サーバーは **両 variant に HeadObject を行い**、`exists` / `Content-Length` / `Content-Type` / `ChecksumSHA256` を宣言値と突き合わせてから READY にする（§5.5）。「クライアントが完了と言っただけ」で READY にしない。

- 宣言と違う sha256 の報告 → `HASH_MISMATCH`、宣言と違う fileSize の報告 → `INVALID_INPUT`（S3 を見るまでもなく拒否）。
- S3 に無い / サイズ不一致 / Content-Type 不一致 → `UPLOAD_NOT_COMPLETE`。
- **checksum が取得できない場合も `UPLOAD_NOT_COMPLETE`**。presigned PUT を `ChecksumSHA256` 付きで発行していれば必ず取れるはずで、取れないなら検証条件が成立していない。
- checksum 不一致 → `HASH_MISMATCH`。
- 既に READY で報告内容も一致 → **NO_OP（成功）**。`completedAssetCount` は増やさない（二重加算防止）。
- 削除済み Asset → `ASSET_NOT_FOUND`。

### 3.4 `completePhotoBatch`

```jsonc
// input
{ "batchId": "...", "imageCountProcessed": 24, "imageCountUploaded": 24 }
// output
{ "batchId": "...", "status": "READY_FOR_REVIEW" }
```

- **DB 上の manifest の集計だけ**で判定する。300 オブジェクトへ HEAD を投げ直さない（§93.5 ケースC: Lambda timeout の原因）。各 Asset の S3 実在確認は 3.3 で 1 件ずつ済んでいる。
- `registered != expected` または `completed != expected` または `failed > 0` → `UPLOAD_NOT_COMPLETE`（`300 expected / 25 registered / 25 completed / 0 failed` の形で返す）。**300 枚予定で 25 枚しか `requestPhotoAssetUploads` していない状態はここで止まる**。残り枚数を送って再開すれば通る（§7.6）。
- クライアント申告枚数がサーバー manifest と食い違う → `CONFLICT`。**重複 SKIP があるとクライアント側の枚数の方が多くなる**ため、Photo Station は `DUPLICATE_SKIP` を数えて**重複除去後の枚数**を送ること。
- `expected == 0` → `EMPTY_BATCH`（運用上は ARCHIVED で破棄）。
- 既に `READY_FOR_REVIEW` / `LINKED` で `openRevision` も無い → **NO_OP（成功）**。二重送信は正常系。
- **`LINKED` の batch で追加 upload revision の finalize が完了しても、status は `LINKED` のまま維持する**（`READY_FOR_REVIEW` へ戻さない、§2.2）。それ以外の status からの finalize は `READY_FOR_REVIEW` へ進む。
- 永続条件（§4）は**読取時の `status` と `revision` も含める**。finalize 処理中に `link` が先に成立していれば読み直させ、`LINKED` を `READY_FOR_REVIEW` へ巻き戻さない。並行する追加 upload が revision を新たに開いた場合も同様に読み直させる。

### 3.5 `linkPhotoBatchToInventory`

```jsonc
// input（actorUserId / role は含めない — §1.1 の信頼境界。認証済みコンテキストから取得する）
{ "batchId": "...", "inventoryId": "..." }
```

- `READY_FOR_REVIEW` かつ未紐付けのときのみ。既に紐付け済み → `BATCH_ALREADY_LINKED`、それ以外の status → `INVALID_STATUS_TRANSITION`。
- `openRevision` が開いている（追加 upload 進行中）→ `UPLOAD_NOT_COMPLETE`。**永続条件にも `attribute_not_exists(openRevision)` を含める**（§4）— 存在確認とその後の更新の間に追加 upload の開始と競合すると、未検証の画像を含んだまま紐付いてしまうため。
- 論理削除済み（`isDeleted=true`）の Inventory への紐付けは `INVENTORY_NOT_FOUND`。存在確認と同時に拒否する（§67）。
- **PhotoAsset を 1 件も書き換えない**（§4.6 / §93.5 ケースA）。300 枚でも書込みは PhotoBatch 1 行 + AuditLog 1 行。
- 1 つの Inventory に複数 PhotoBatch を紐付け可能（§4.7 再撮影・追加撮影）。
- 紐付け解除・別商品への付け替え（§27）は **Phase 2**。この契約には含まない。

### 3.6 `deletePhotoAsset` / `restorePhotoAsset`

- 削除は**論理削除のみ**。`isDeleted=true` / `status=DELETED`。**S3 オブジェクトは消さない**（§12）。物理削除・Lifecycle は導入しない。
- **出品で使用中なら `ASSET_IN_USE` でブロック**する。警告して続行させない（§68）。外すには先に出品の選択から明示的に外す。参照カウンタは PhotoAsset 行自身が持つ値を使う（ListingImageSelection の GSI 逆引きは結果整合で古くなり得るため使わない）。
- **永続条件は読取時の Asset `status` も含める**（`isDeleted=false AND #status='<読取時のstatus>' AND listingSelectionCount=0`）。判断の後に `completePhotoAssetUpload` が先に成立すると `completed` を減らすべきか否かが変わり manifest が壊れるため、読み直させる。
- 二重削除は NO_OP。
- 復元は**削除前の状態へ戻す**。記録が無い場合は READY ではなく `UPLOADING` へ戻し、再 complete で検証させる（検証なしで READY にしない）。
- **復元は ADMIN のみ**（§47）。role は認証済みコンテキストの値であり、クライアントの申告ではない（§1.1）。STAFF による復元は `PERMISSION_DENIED`。
- **復元対象の `photoAssetId` は所属する `batchId` と照合する**。別 batch の Asset を取り違えると manifest が別 batch のものになるため `ASSET_NOT_FOUND`。
- 復元で 300 枚を超える場合は `ASSET_LIMIT_EXCEEDED`（永続条件は `expectedAssetCount <= 299` の境界値比較として実装する。DynamoDB の ConditionExpression は `expectedAssetCount + 1 <= 300` のような算術を直接書けないため、§4 の注記のとおり呼び出し側で境界値へ変換する）。
- 画像の差し替えは「旧 Asset を削除 + 新 Asset を追加」（§67）。上書きしない。

### 3.7 `setListingImageSelection`

```jsonc
// input
{ "listingId": "...", "photoAssetIds": ["...", "..."] }   // 配列順 = 出品順、先頭がメイン
```

- 選択できるのは **READY かつ未削除**で、**その出品の Inventory に紐付いた batch**の Asset のみ。違反はそれぞれ `INVALID_STATUS_TRANSITION` / `CONFLICT`。
- 重複選択 → `INVALID_INPUT`。チャネル上限超過 → `CHANNEL_IMAGE_LIMIT_EXCEEDED`。**上限値は契約にハードコードせず設定値として渡す**（§22: 各 EC の仕様が未確定）。
- 0 枚選択は正当（既存下書きの画像を使う場合を含む）。
- **置換は丸ごと置換であり、読取時の選択 `selectionRevision` を条件にする。** 2 人が同時に置換すると、両方が同じ「旧選択」を基準に参照カウンタを減算してしまい、実際より小さい値になって使用中の画像が削除可能になる。版が違えば失敗させ読み直させる。
- 選択/解除は PhotoAsset の**参照カウンタの増減**として行い、選択行の書込み・`selectionRevision` の更新と同一 transaction にする。選択対象 Asset へも `isDeleted=false AND #status='READY'` を同一 transaction で条件化する — 削除側（`listingSelectionCount=0` が条件）と同じカウンタを挟むため、削除と選択は必ずどちらか一方だけが成功する（§4 の削除競合）。
- 既存 `ListingDraft.images`（storageKey の JSON 配列）は変更しない。新旧併存。

## 4. AWS 側で原子性が必須の操作（ローカルでは検証不能）

`decide*` が返す `conditions`（`AtomicCondition[]`）は、**DynamoDB の ConditionExpression / TransactWriteItems として実装されなければならない**。「GSI で検索して無ければ Create/Update」は結果整合の遅延で破れる（§93.5 ケースB）。

**`predicate` は説明用の述語であり、そのまま実行できる ConditionExpression ではない。** DynamoDB は `expectedAssetCount + 1 <= 300` のような算術を条件式にそのまま書けないため、算術は呼び出し側（Lambda）で計算し、`expectedAssetCount <= 299` のような**計算済みの境界値との比較**として実装すること。下表の predicate も、実際の値を埋めた境界値の形で記載している。

| # | 操作 | 条件（読取時の値を埋めた境界値の形） | 破れた時 |
|---|---|---|---|
| 1 | createPhotoBatch | `PhotoIdempotency#SESSION#<sessionId>` へ `attribute_not_exists(pk)` の Put ＋ PhotoBatch Put を同一 transaction | 読み直して既存 batch を返す |
| 2 | requestUploads（新規 Asset がある場合） | `PhotoAssetIdempotency#(batch,clientAssetId)` へ `attribute_not_exists(pk)`／`PhotoAssetHash#(batch,sha256Processed)` へ `attribute_not_exists(pk)`／PhotoBatch へ `#status = '<読取時status>' AND expectedAssetCount = <読取時の値> AND registeredAssetCount <= <planLimit − 今回の新規件数>` を同一 transaction | `IDEMPOTENCY_CONFLICT` / `CONFLICT` / `ASSET_LIMIT_EXCEEDED` |
| 2a | requestUploads（revision を新規に開く場合） | 上記に加え PhotoBatch へ `attribute_not_exists(openRevision)` | `CONFLICT`（revision を二重に開かせない） |
| 3 | completeAssetUpload | PhotoAsset へ `#status = '<読取時status>' AND isDeleted = false` ＋ PhotoBatch へ `completedAssetCount <= <expectedAssetCount − 1>` ＋ `completedAssetCount` 加算を同一 transaction | `CONFLICT`（二重加算・削除との競合を防ぐ唯一の手段） |
| 4 | completePhotoBatch | PhotoBatch へ `#status = '<読取時status>' AND revision = <読取時revision> AND expectedAssetCount = <n> AND registeredAssetCount = <n> AND completedAssetCount = <n> AND failedAssetCount = 0` | `CONFLICT`（finalize 中の link 成立・revision 追加を検知し読み直させる） |
| 5 | link | PhotoBatch へ `attribute_not_exists(inventoryId) AND #status = 'READY_FOR_REVIEW' AND attribute_not_exists(openRevision)` ＋ `Inventory` の `attribute_exists(id) AND isDeleted <> true` を同一 transaction | `BATCH_ALREADY_LINKED` / `INVENTORY_NOT_FOUND`。**二者同時登録の後勝ちを防ぐ唯一の手段**（§59 / ケースE）。`openRevision` の非存在も同一条件に含め、追加 upload 開始との競合を排他する |
| 6 | deleteAsset | PhotoAsset へ `isDeleted = false AND #status = '<読取時status>' AND listingSelectionCount = 0` ＋ manifest 減算（`expected`/`registered`/`completed`/`failed`）を同一 transaction | `ASSET_IN_USE`（読取時 status も条件にし、completeとの競合でmanifestが壊れないようにする） |
| 7 | restoreAsset | PhotoAsset へ `isDeleted = true AND #status = 'DELETED' AND statusBeforeDelete = '<復元先status>'` ＋ PhotoBatch へ `expectedAssetCount <= 299` | `CONFLICT` / `ASSET_LIMIT_EXCEEDED` |
| 8 | Listing 選択 | `ListingImageSelectionState#<listingId>` へ `selectionRevision = <読取時の値>` ＋ 選択各 Asset へ `isDeleted = false AND #status = 'READY'` ＋ 参照カウンタ増減 ＋ 選択行の書込み・`selectionRevision` 更新を同一 transaction | `CONFLICT`（同時置換の二重減算防止）／`ASSET_NOT_FOUND`。6 と同じ参照カウンタを挟むので、削除と選択は必ずどちらか一方だけが成功する |

補足:

- 削除可否の判定に **ListingImageSelection の GSI 逆引きを使わない**。結果整合で古い値を読み、使用中の画像を削除できてしまう。PhotoAsset 行自身の参照カウンタを条件式で見る。
- **既知の限界（このローカル契約では埋まらない）**: `MAX_ASSETS_PER_BATCH`（300、論理削除されていない Asset 数）の絶対上限チェックは、現状 `decideRequestUploads` / `decideRestoreAsset` が読取時の `assets` 一覧・`activeAssetCount` を数える**決定時点の判断**にとどまり、上表の transaction 条件には独立した「300 件境界」の ConditionExpression としては含まれていない（restore は `expectedAssetCount <= 299` を持つが、request 側の 300 上限は読取と書込みの間の競合を条件式で閉じていない）。AWS 実装時は `PhotoAsset(photoBatchId, sequence)` の件数を transaction 内で保証する設計が必要で、これは Phase 1 AWS 実装（未着手）の課題として残す。

## 5. 必要な AWS リソース・権限（すべて未承認・未適用）

- 新規モデル: `PhotoBatch` / `PhotoAsset` / `ListingImageSelection` / `PhotoIdempotency` / `PhotoAuditLog`（加算のみ。既存モデルの破壊的変更なし）。
- GSI（Scan 禁止のため必須、§4.5）: `PhotoBatch(status, uploadedAt)` / `PhotoBatch(inventoryId, linkedAt)` / `PhotoBatch(localImportSessionId)` / `PhotoAsset(photoBatchId, sequence)` / `PhotoAsset(photoBatchId, sha256Processed)` / `ListingImageSelection(listingId, sequence)` / `ListingImageSelection(photoAssetId, listingId)` / `PhotoAuditLog(batchId, createdAt)`。
- S3: `photo-batches/*` の PutObject（presigned、checksum 固定）と GetObject / HeadObject のみ。**DeleteObject 不要**、既存 prefix の権限は変更しない、public 化しない、RAW Lifecycle は入れない。
- CORS: Photo Station / ブラウザからの PUT に必要な最小 origin のみ。`*` にしない（§76）。
- Cognito: `PHOTO_DEVICE` 相当の端末専用グループが必要。既存 `EDITOR` の流用は **不可**（Inventory 編集権限まで与えてしまう）。既存グループの改名・破壊的変更はしない。
- 既知の制約: Secret / DynamoDB 直結の IAM 許可は列挙式で、現在の承認範囲は予算台帳 2 テーブルに限られる。画像機能の IAM 追加は**その承認に含まれていない**。

## 6. Photo Station 側への要求（接続仕様が確定したら）

1. `localImportSessionId` を取込ごとに 1 個生成し、再送でも変えない。
2. 25 件ずつの chunk で `requestPhotoAssetUploads`。並列は 4〜8 本まで（§7.5 代替B）。
3. presigned URL で S3 へ直接 PUT。`Content-Type` / `Content-Length` / `ChecksumSHA256` を署名条件どおりに送る。
4. 1 枚ごとに `completePhotoAssetUpload`。失敗は個別に再試行してよい。
5. すべて完了後に `completePhotoBatch` へ **重複除去後の枚数**（`DUPLICATE_SKIP` を除いた数）を送る。
6. `IDEMPOTENCY_CONFLICT` / `INVALID_INPUT` は再送しない。`CONFLICT` は読み直してから再送。
7. 在庫の選択・Inventory の更新は行わない（§1.1）。

## 7. 検証済み / 未検証

**この文書・実装の変更後の合成試験・型検査は、この修正を行った担当（Claude）自身は実行していない。** 実行はホストの IndependentVerifier が別途行う（`node scripts/qa/run-verify-with-server-only-noop.cjs scripts/verify-photo-registration-contract.ts` 等）。過去のレビューで記録された合格件数（例: 55 checks）は、その後の修正（`expectedAssetCount` 必須化・`additionalExpectedCount` によるrevision固定・`sourceType`/`actor`の信頼境界分離・`originalExpectedAssetCount`不変値など）で試験内容・件数とも変わっているため、**古い件数をここに記載しない**。

`scripts/verify-photo-registration-contract.ts` がカバーする観点（実行結果は未確認）:

0 / 1 / 20 / 100 / 300 / 301 枚の境界、25 / 26 件 chunk、サイズ・checksum 形式・MIME の不正、chunk 内重複、同一 clientAssetId の再送（同一 hash → 再発行、hash 変更 → CONFLICT、READY 済み → URL 非発行）、batch 内 hash 重複の SKIP と manifest 整合、**300 枚予定・25 枚 registered での finalize 拒否と残 275 枚再開後の finalize 成功**、予定枚数超過の拒否、**同一 session での `expectedAssetCount` 変更拒否（revision 後の元 create 再送は許容）**、二重 complete / 二重 finalize の NO_OP、READY_FOR_REVIEW 以外の link 拒否、二者同時 link、**追加 upload revision の途中再送・二重加算防止・開いた予定数と異なる再送の CONFLICT**、使用中削除のブロック、論理削除と復元（ADMIN 限定・batch 照合）、追加 upload 中の既存 READY 画像保全、Listing 選択の `selectionRevision` 競合防止、S3 キーの不変性、PhotoAsset に `inventoryId` が無いこと、`actorUserId`/`role` が検証済み型に含まれないこと、遷移表。

**この試験では検証していない（できない）**:

- DynamoDB の条件付き書込み・transaction が実際に原子的に効くこと（§4 の 9 項目すべて）。合成 state は単なる逐次更新で、並行性が無い。
- S3 オブジェクトの実在・HeadObject の挙動・presigned URL の署名条件・期限切れ・CORS。HEAD 結果は合成値を渡しているだけで、S3 へはアクセスしていない。
- Cognito 認証、`PHOTO_DEVICE` 権限の分離、AppSync の認可。
- 300 枚 finalize の実性能、Lambda timeout。
- 未登録一覧・batch 詳細・在庫候補・商品詳細・EC 出品の各画面（未実装）。
- 既存 Inventory 画像 / 既存 EC 出品 / CSV・ZIP 出力への影響（新規ファイルのみのため影響しないが、実結合では未確認）。
- 実運用と分離された staging 環境の存在そのもの（未確定）。

## 8. 未解決・Phase 2 以降

- 紐付け解除 / 別商品への付け替え（§27）、並び替え（§15）、メイン画像設定（§23）、ダウンロード（§14）、再加工（§35）。
- `batchCode` による検索を Scan なしで行うための索引設計。
- 未登録件数 badge の集計方式（GSI Query のページ付き COUNT か小さな集計キャッシュか）。
- `Inventory.photoStatus`（§19）の追加可否。既存の業務 status は**自動変更しない**（§19.5）。
- 整合性監査スクリプト（§70）。ただし §70 の「asset の inventoryId 不一致」は §4.6 と矛盾するため、PhotoAsset に `inventoryId` を追加せず、batch リンクと Listing 参照の整合だけを検査する。

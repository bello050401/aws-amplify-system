# 画像登録 Web UI / server action 境界 (Phase 1 続き、AWS未接続)

対象: commit 4bef902 (「feat(photo): add verified registration API foundation」) で導入済みの
`lib/photoRegistration/{types,validation,state,auth,keys,service,ports,awsRepository,awsStorage}.ts`
(契約・状態遷移・権限判定・AWSアダプター) を、Next.js の Web UI / Server Action から
呼べる形に配線した工程。**この工程では上記の既存API基盤ファイルを一切変更していない。**

## この工程で追加したファイル

| ファイル | 役割 |
|---|---|
| `lib/photoRegistration/webAdapter.ts` | 実AWSクライアント構築 (fail closed)・Cognitoセッション→`TrustedClaims`変換・署名GET URL発行・Web専用の薄いdispatch (`PhotoRegistrationWebAdapter`)。新しい業務判断はしない。 |
| `app/actions/photoRegistration.ts` | `"use server"`。Client Componentから呼べる形への変換、`PhotoErr.message`→利用者向け日本語文言への差し替え、`revalidatePath`。 |
| `app/inventory/(protected)/photo-registration/page.tsx` / `PhotoBatchListTable.tsx` | 未登録バッチ一覧 (cursorはURLの`?cursor=`に載る、リロード・共有・戻る操作が有効)。 |
| `app/inventory/(protected)/photo-registration/[batchId]/page.tsx` | バッチ詳細。画像ページングは`?assetPage=`。 |
| `app/inventory/(protected)/photo-registration/[batchId]/PhotoAssetGrid.tsx` | サムネイル一覧・論理削除(STAFF/ADMIN)・復元(ADMIN限定、UI側でも出し分け、実際の許可判定は必ずservice側)。 |
| `app/inventory/(protected)/photo-registration/[batchId]/WebUploadPanel.tsx` | Web追加upload。ブラウザ側でSHA-256計算・サムネイル生成・S3への直接PUT。 |
| `app/inventory/(protected)/photo-registration/[batchId]/InventoryLinkPanel.tsx` | Inventory候補検索・2段階の紐付け確認。 |
| `app/inventory/InventoryNavRail.tsx` / `MobileBottomNav.tsx` | 「画像登録」ナビ項目・未登録件数badge (`usePhotoRegistrationBadge`)。 |
| `scripts/verify-photo-registration-web.ts` | 合成試験。 |

## fail closed の実際の意味

画像登録専用のDynamoDBテーブル・S3バケットは、このタスクの対象外である `amplify/backend.ts` /
`amplify/data/resource.ts` / `amplify/storage/resource.ts` が未変更のため **現時点でAWS上に存在しない**。
`lib/photoRegistration/webAdapter.ts` の `getPhotoRegistrationWebAdapter()` は

```
PHOTO_REGISTRATION_TABLE_NAME
PHOTO_REGISTRATION_INVENTORY_TABLE_NAME
PHOTO_REGISTRATION_BUCKET_NAME
```

のいずれかが環境変数に無ければ **例外を投げずAWSクライアントを構築せずnullを返す**。
`app/actions/photoRegistration.ts` の全アクションはこれを最初に確認し、未設定なら
`{ ok:false, code:"NOT_CONFIGURED" }` を返す。Web UI側 (一覧・詳細ページ) はこれを
「AWS未接続」の案内として表示し、空配列や成功と混同しない。したがって**現時点でこの画面は
実データを一切扱わず、常にNOT_CONFIGURED状態で表示される**。

`PHOTO_REGISTRATION_AWS_REGION` は省略時 `lib/photoRegistration/types.ts` の
`PHOTO_REGISTRATION_REGION` (`us-west-2`) を使う。

## 認証・信頼境界

- `getWebTrustedClaims()` は `lib/amplify/requireInventoryUser.ts` の
  `getInventorySessionStatus` と同じ手法 (`runWithAmplifyServerContext` + `fetchAuthSession`) で
  Cognitoセッションから `userId` / `cognito:groups` を読む。Web UIのセッションは
  `PHOTO_DEVICE` 専用トークンを持たないため `deviceId` は常に `null`。
- role (`ADMIN` / `STAFF` / `PHOTO_DEVICE`) への写像・operationごとの許可・
  `photoDeviceGroupDeployed` による fail closed は `lib/photoRegistration/auth.ts`
  (既存・変更禁止) がそのまま行う。`webAdapter.ts` の `authConfig` は
  `{ photoDeviceGroupDeployed: false }` 固定 — `PHOTO_DEVICE` グループは未デプロイ。
- クライアントの自己申告role/sourceType/actorIdは一切読まない。Inventory候補検索
  (`searchInventoryCandidatesAction`) だけは既存Inventoryシステム自身の
  role (`ADMIN`/`EDITOR`/`VIEWER`、`lib/amplify/requireInventoryUser.ts`) で判定する別ドメイン。

## 画像URLの境界

- 一覧画面はサムネイルを出さない — batch内Asset(最大300件)をN+1で読むコストを避けるため。
- 詳細画面はページ単位 (既定24件) でのみ `getSignedUrl` (S3 GetObject) を発行する。
  presign自体はオフライン署名でネットワークを使わない (`lib/photoRegistration/awsStorage.ts` の
  presigned PUTと同じ理屈)。
- DBにはpresigned URLを保存しない。ブラウザはS3の資格情報・SDKクライアントを一切持たない。

## Web追加uploadの入力制限

- MIME: `image/jpeg` / `image/png` / `image/webp` のみ (`lib/photoRegistration/types.ts`
  `WEB_UPLOAD_PROCESSED_MIME_TYPES`)。
- サイズ: processed 25MB / thumbnail 2MB (`MAX_PROCESSED_BYTES` / `MAX_THUMBNAIL_BYTES`)。
- 件数: 1回の追加につき `MAX_WEB_UPLOAD_FILES_PER_REQUEST` (20枚、契約上のchunk上限25より
  少なく余裕を残す)。
- 拡張子: `lib/photoRegistration/validation.ts` はmimeType/size/hashの形式しか見ないため、
  `webAdapter.ts` の `validateWebUploadFileName` がfileNameの危険な拡張子 (`.exe`/`.js`/`.svg`/
  `.html`等) を拒否し、mimeTypeと拡張子の不一致も拒否する。この検証はDB/S3へ触れる前に行う。
- 二重送信防止: `WebUploadPanel.tsx` は送信中 `submitting` state でボタン・inputを無効化する。

## finalizeの信頼境界

`finalizeWebUploadAction` はクライアントから枚数を受け取らない。直前に
`repository.getBatchById` で読み直したサーバー側 `manifest.expectedAssetCount` をそのまま
`completePhotoBatch` の申告枚数として使う — Web UIはアップロード対象の総数を検証可能な形で
保持していないため、クライアント自己申告をfinalizeの根拠にしない。

## 商品詳細・Listing/CSV統合・Photo Stationとの関係

この工程はPhoto Station側の実装・商品詳細画面への画像統合・Listing/CSV出力を対象にしない
(依頼文の指示どおり)。`setListingImageSelection` 等、既存service.tsに実装済みだが
このWeb UIからは呼ばないoperationにも触れていない。

## 未検証・既知の限界

- 実AWS (DynamoDB/S3/Cognito) との結合は未検証 — 上記のとおりテーブル/バケットが
  未デプロイのため検証しようがない。`scripts/verify-photo-registration-web.ts` は
  `scripts/verify-photo-registration-api.ts` と同じフェイクDynamoDB/S3で
  `PhotoRegistrationWebAdapter` を直接検証する。
- ブラウザでの実際のレンダリング・実ファイルでのアップロード往復は未検証 (テストはホストが
  別途実行)。
- Inventory候補検索の一覧にサムネイルは出していない (テキストのみ) — 既存の
  Inventory画像URL解決の仕組みへ新たに依存を増やさない、スコープを絞った判断。

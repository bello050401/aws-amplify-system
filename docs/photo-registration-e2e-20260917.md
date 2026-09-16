# 画像登録 Phase 1 隔離 E2E 記録（2026-09-17）

## 結果

BELLO Development Orchestrator の開発経路として、テストタスク受付、実装、独立テスト、隔離 staging 反映、HTTP確認、完了記録までを通した。画像登録経路は Cognito 認証、API Gateway、Lambda、DynamoDB、S3 を実際に通り、1件の画像バッチを在庫へリンクして `LINKED` になった。

- 検証画面: https://photo-e2e.d2ksii56z597id.amplifyapp.com/
- Amplify app: `bello-photo-e2e-validation` (`d2ksii56z597id`)
- branch: `photo-e2e`（`DEVELOPMENT`、Git接続なし、自動ビルドなし）
- CloudFormation stack: `bello-photo-e2e-validation` / `us-west-2`
- 検証batch: `41335fb8-16ea-47cf-bc15-932f3303bd17`
- 検証inventory: `inv-e2e-001`
- Amplify deployment job: `2` / `SUCCEED`
- HTTP: `200`、`E2E検証 成功` と `LINKED` を照合

## 分離境界

専用の Cognito User Pool、オンデマンド DynamoDB Photo/Inventory table、private・versioned S3 bucket、Lambda、HTTP API をCloudFormationで構築した。Amplify側にはrepository、環境変数、実行role、backend接続がなく、既存stagingやproductionから独立している。

外部サービス用secretは設定していない。ZAICO、LINE、Mercari、顧客データ、実注文、実出品、本番同期、顧客送信は使用していない。IAMは専用テーブル、専用bucketの `photo-batches/*`、Lambdaログに限定した。DynamoDBはオンデマンド、Lambda/APIは呼出時のみ、Amplifyは静的な小ページであり、常時稼働サーバーを追加していない。

## 実経路で見つけて直した点

1. API Gateway が Cognito group claim を `[PHOTO_DEVICE]` の形式で渡す場合も認可できるよう正規化した。
2. presigned PUT の SHA-256 checksum を署名対象headerとして残した。Photo StationもURL形式に応じてheaderを送り、S3 `HEAD` で `ChecksumSHA256` が保存されたことを確認した。
3. 在庫リンクtransactionに必要な `dynamodb:ConditionCheckItem` を、隔離Inventory tableだけへ追加した。
4. 同一sessionの再実行で checkpoint から復旧し、重複作成せず `READY_FOR_REVIEW` まで完了した。

## 検証結果

- API service: 26 passed
- API contract: 67 passed
- Web adapter/UI: 19 passed
- Listing integration/CSV/ZIP: 10 passed
- Photo Station client: 5 passed
- TypeScript: `tsc --noEmit` passed
- 実AWS: Cognito認証、presigned S3 PUT、SHA-256保存、DynamoDB永続化、在庫リンク、再読込で `LINKED` を確認
- Amplify Hosting: job 2 `SUCCEED`、HTTP 200、表示内容一致

## 再起動・再読込耐性

状態はLambdaメモリではなくDynamoDBへ保存される。別のCognito管理者トークンを取り直して `listBatchesForInventory` を再実行し、同じbatch、inventory、`LINKED` が返ることを確認した。Photo Stationのcheckpointもsession単位でディスクへ原子的に保存する。

# BELLO AWSテスト環境構築 — 調査結果・引き継ぎメモ

このファイルは「AWSテスト環境構築・ZAICO実データ少数同期・画像クラウド保存」指示への対応で判明した事実と、次工程(EC出品統合)が再調査せずに済むようにするための記録。`docs/NOTES_BELLO.md`の補足に位置づける — 全体地図はそちらを見ること。

## 1. 実行主体(ローカル / AWS Amplify Hosting)の整理

このアプリのInventoryサーバーサイドコードは、大きく2種類の「AWSへのアクセス方法」を使い分けている。この違いを理解しないと、IAM権限をどこへ付与すべきかを誤る。

### (A) Amplifyのサーバーサイド認可ヘルパー経由(`runWithAmplifyServerContext`)
- 使用箇所: `lib/amplify/dataClient.ts`(AppSync/Data)、`lib/amplify/serverUtils.ts`経由の`lib/inventory/imageServerOps.ts`(S3/Storage)、`lib/amplify/requireInventoryUser.ts`(Cognito認証)。
- 仕組み: Next.jsのリクエストが持つ**サインイン中ユーザー自身のCognitoセッションCookie**を読み、そのユーザーのCognito User Pool JWT / Cognito Identity Poolが発行する一時IAM認証情報を使う。
- **結論**: AppSync(Inventory等のCRUD)もS3(画像アップロード/削除/コピー)も、実行しているのは「Amplify Hostingの実行ロール」ではなく「今アクセスしているADMIN/EDITOR/VIEWERユーザー自身のCognito Identity Poolロール」。この権限は`amplify/data/resource.ts`の`allow.group(...)`、`amplify/storage/resource.ts`の`access`設定によって**Amplify Gen2のバックエンドデプロイだけで自動的に用意される** — Amplify Console側で追加のIAMポリシー手動設定は一切不要。

### (B) 生のAWS SDKクライアントを直接生成(ambient credential chain)
- 使用箇所: `lib/zaico/secretStore.ts`(`new SecretsManagerClient({ region })`)のみ。
- 仕組み: `runWithAmplifyServerContext`を経由せず、AWS SDK標準の資格情報プロバイダーチェーンにそのまま頼っている。
  - ローカル`npm run dev`実行中 → 開発者のローカル端末のAWS CLIプロファイル/SSOセッション。
  - Amplify Hostingへデプロイ後 → **Amplify HostingのSSRコンピュートに割り当てられた実行ロール**(Amplify Gen2が自動生成するロールで、`defineBackend()`からは直接ポリシーを追加できない — 後述)。
- **結論**: 「Hosted環境でIAM追加設定が本当に必要なのはSecrets Managerだけ」。画像のS3保存には追加のIAMロール設定は不要(上記(A)の枠組みで完結している)。

この区別は今回の調査で確定した事実であり、以前のラウンドの一部コメントが「Secrets ManagerもS3も同じHosting実行ロールへの権限付与が必要」であるかのように読める書き方をしていた点を、ここで訂正する。

## 2. セットアップスクリプト(`scripts/aws-setup/`)

Windows PowerShell + AWS CLIから一度に実行できるスクリプト一式を用意した(手作業のコマンド転記を最小化するため)。実行順序・安全上の注意は `scripts/aws-setup/README.md` を参照。

1. `1-discover.ps1`(読み取り専用) — 現在のAWS identity(rootでないか確認)・region・既存Amplifyアプリ/ブランチ・SSRコンピュートロールらしきARN・Secretsの存在有無を一括確認する。何も変更しない。
2. `2-apply-secrets-policy.ps1`(書き込みあり、要確認プロンプト) — `1-discover.ps1`で特定したロール名を渡すと、Secrets Manager用の最小権限ポリシー(下記)を追加する。
3. `3-create-branch.ps1`(書き込みあり、要確認プロンプト) — 既存Amplifyアプリへ`claude/inventory-management-system-5vbvc7`ブランチを追加し、初回ビルドを開始する。

**Amplifyアプリ自体がまだ存在しない場合**(`1-discover.ps1`が「見つかりませんでした」と表示した場合)は、GitHub OAuth同意を伴うため`3-create-branch.ps1`は使えず、下記§4の手順でAWS Console操作が必要(BLOCKED_BY_USER)。

## 3. Secrets Manager用IAMポリシー(参考・`2-apply-secrets-policy.ps1`が自動生成する内容と同一)

Secret名: `bello/zaico-api-token` / Region: `us-east-1`(`amplify/backend.ts`で定義)。

Secrets Managerの仕様上、Secretの完全なARNには作成時にランダムな6文字のsuffixが付与される(`bello/zaico-api-token-XXXXXX`)。`CreateSecret`のAuthorizationはsuffix無しの名前に対して評価される一方、`GetSecretValue`/`PutSecretValue`は実際のARN(suffix込み)に対して評価されるため、Resourceは以下のようにワイルドカードでsuffix部分だけを許容する(名前全体を`*`にはしない)。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BelloZaicoTokenSecretAccess",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:CreateSecret"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:bello/zaico-api-token-??????"
    }
  ]
}
```

`secretsmanager:ListSecrets`・`DescribeSecret`・`DeleteSecret`は現行コード(`lib/zaico/secretStore.ts`)が一切呼ばないため付与しない。手動で適用する場合は`2-apply-secrets-policy.ps1 -RoleName <ロール名>`を実行すればよい(このJSONを自動生成して確認プロンプト付きで適用する)。

## 4. Amplify Hostingブランチデプロイ(BLOCKED_BY_USER — Amplifyアプリが未作成の場合のみ)

`1-discover.ps1`の結果、bello050401/aws-amplify-system用のAmplifyアプリが存在しない場合、GitHub連携を伴うAmplify Console操作が必要 — Claude Codeからは実行不可(GitHub OAuth同意はユーザー本人のブラウザ操作が前提)。

1. AWS Console → **Amplify** → 「新しいアプリの作成」→「GitHubからデプロイ」
2. GitHubアカウント認可 → リポジトリ `bello050401/aws-amplify-system` を選択
3. ブランチとして `claude/inventory-management-system-5vbvc7` を選択(**mainは選択しない**)
4. ビルド設定はリポジトリ直下の `amplify.yml` がそのまま使われる(既存のGen2 + Next.js SSR標準構成、変更不要)
5. デプロイ実行 → 完了後、そのブランチ専用のURLが発行される

Amplifyアプリが既に存在する場合は、上記STEP 1〜4の代わりに`3-create-branch.ps1`をそのApp IDで実行すればよい(GitHub App連携済みのアプリであれば、CLIからのブランチ追加だけでWebhook経由の自動ビルドが有効になる)。**重要**: どちらの経路でも別ブランチの追加であり、`main`ブランチの設定・本番ドメインには一切触れない。

## 5. ZAICO少数件テスト同期(今回コード実装済み)

`/inventory/settings` のZAICO同期パネルに追加:

- **「ZAICOの件数を確認（同期しない）」**: `lib/inventory/zaicoSync.ts`の`previewZaicoCatalogSize()`。ZAICO一覧APIの1ページ目だけを取得し、「少なくともN件」を表示する(ZAICO APIが総件数を返さないため、正確な総数は開示できない — 誇張しない表現にしている)。
- **「テスト同期する」**(既定5件、最大50件): `syncLimitedZaicoItems(limit, who)`。既存の`syncAllZaicoItems`に`{ limit }`オプションを追加しただけで、ページ途中でも指定件数に達した時点で即座に打ち切る(それ以上ページを取得しない)。
- 冪等性: 既存の`findExistingZaicoInventory`/`fetchAllZaicoManagedInventory`(`sourceInventoryId`によるルックアップ)がそのまま使われるため、同じ5件を何度再実行しても重複作成されない(create/update/unchangedの分岐は元から実装済み)。
- 削除同期: 実装していない(元から存在しない) — ZAICO側に存在しない商品を検出してBELLO側を自動削除する処理は今回も追加していない。

## 6. 画像パイプライン(調査結果: 既にS3ベースで完成していた)

`lib/inventory/imageServerOps.ts`の`downloadAndImportInventoryImage()`は、以前のPhaseで既に「ZAICOの画像URLをサーバー側でfetch → Blobとしてメモリ保持 → Amplify Storage(S3)へ`uploadData`」という設計で実装済みだった。ローカルディスクへの永続保存は一切行っていない(一時変数としてのBlob以外、ファイルシステムに触れる箇所が無い)。今回追加で強化した点:

- fetchにタイムアウト(15秒、AbortController)を追加。
- レスポンスの`Content-Type`を実際に検査し、許可された画像MIME型以外を拒否(拡張子は信用しない)。
- `Content-Length`ヘッダとダウンロード後の実バイト数の両方で20MB上限を強制。
- ZAICO側画像が消失(`item_image`がnull)した場合、既存のBELLO側S3画像は削除せず維持しつつ、その旨を同期結果の警告として可視化(検出のみ、削除はしない)。

オブジェクトキー: `inventory/<uuid><拡張子>`(既存の命名規則、他の画像アップロードと共通)。重複防止: 画像のsourceUrlが前回と同じなら再ダウンロード・再アップロードしない(既存実装)。

## 7. 今回スキーマ変更なし

上記の全機能は既存のInventoryスキーマ(`sourceSystem`/`sourceInventoryId`/`InventoryImage`の`sourceSystem`/`sourceUrl`)だけで実現できており、`amplify/data/resource.ts`への変更は不要だった。将来EC統合フェーズで新しいモデル(EcListing等)を追加する際も、この調査で確認した「Inventoryが唯一の真実源」という前提は崩していない。

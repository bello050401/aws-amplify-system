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

## 2. Amplify Hosting SSR実行ロールの特定方法(BLOCKED_BY_USER)

このロールの実名・ARNは、実際にAmplify Hosting上へこのアプリがデプロイされていないと存在しない。Claude Codeのこのセッションには実AWS認証情報がなく特定不可能。ユーザーが以下の手順で特定する。

```powershell
# 前提: AWS CLIがインストール済み、AWS SSOプロファイル(前回までの例: Bello)でログイン済み
aws sso login --profile Bello

# Amplifyアプリ一覧からアプリIDを確認
aws amplify list-apps --profile Bello --region us-east-1

# 対象アプリのSSRコンピュートロールを確認(Amplify Hosting for Next.js SSR)
aws amplify get-app --app-id <APP_ID> --profile Bello --region us-east-1
```

または AWS Console: **Amplify → 該当アプリ → App settings → Hosting compute → SSRの実行ロール**のリンクをたどるか、**IAM → ロール**で `amplify-<appId>-<branch>-<ハッシュ>-computeRole` のような名前のロールを探す。

## 3. Secrets Manager用IAMポリシー(このロールへ付与するインラインポリシー例)

Secret名: `bello/zaico-api-token` / Region: `us-east-1`(`amplify/backend.ts`で定義)。

Secrets Managerの仕様上、Secretの完全なARNには作成時にランダムな6文字のsuffixが付与される(`bello/zaico-api-token-XXXXXX`)。作成前は正確なsuffixが分からないため、`CreateSecret`のAuthorizationはsuffix無しの名前に対して評価される一方、`GetSecretValue`/`PutSecretValue`は実際のARN(suffix込み)に対して評価される。そのため、Resourceは以下のようにワイルドカードでsuffix部分だけを許容する(名前全体を`*`にはしない)。

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

`<ACCOUNT_ID>`は`aws sts get-caller-identity --profile Bello`で確認できる。`secretsmanager:ListSecrets`・`DescribeSecret`・`DeleteSecret`は現行コード(`lib/zaico/secretStore.ts`)が一切呼ばないため付与しない。

適用コマンド例(PowerShell、上記でロール名を特定済みとして):

```powershell
aws iam put-role-policy `
  --role-name <SSR_COMPUTE_ROLE_NAME> `
  --policy-name BelloZaicoSecretAccess `
  --policy-document file://zaico-secret-policy.json `
  --profile Bello --region us-east-1
```

## 4. Amplify Hostingブランチデプロイ(BLOCKED_BY_USER)

`claude/inventory-management-system-5vbvc7`ブランチをインターネット経由のstaging URLとして確認できるようにするには、GitHub連携を伴うAmplify Console操作が必要 — Claude Codeからは実行不可(GitHub OAuth同意・AWS Console操作はユーザー本人のブラウザ操作が前提)。

手順(初回、Amplifyアプリ自体が未作成の場合):
1. AWS Console → **Amplify** → 「新しいアプリの作成」→「GitHubからデプロイ」
2. GitHubアカウント認可 → リポジトリ `bello050401/aws-amplify-system` を選択
3. ブランチとして `claude/inventory-management-system-5vbvc7` を選択(**mainは選択しない**)
4. ビルド設定はリポジトリ直下の `amplify.yml` がそのまま使われる(既存のGen2 + Next.js SSR標準構成、変更不要)
5. デプロイ実行 → 完了後、そのブランチ専用のURL(`https://<branch>.<appId>.amplifyapp.com`)が発行される

既にAmplifyアプリが存在する場合は、「App settings → ブランチ」から同ブランチを追加するだけでよい。**重要**: 別ブランチの追加であり、`main`ブランチの設定・本番ドメインには一切触れない。

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

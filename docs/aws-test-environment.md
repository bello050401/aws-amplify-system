# BELLO AWSテスト環境構築 — 調査結果・引き継ぎメモ

このファイルは「AWSテスト環境構築・ZAICO実データ少数同期・画像クラウド保存」指示への対応で判明した事実と、次工程(EC出品統合)が再調査せずに済むようにするための記録。`docs/NOTES_BELLO.md`の補足に位置づける — 全体地図はそちらを見ること。

## 0. 【TEMPORARY WORKAROUND】amplify.ymlのnpm ci→npm install(暫定対応)

**現状**: `amplify.yml`のbackend/frontend両フェーズで`npm ci`を`npm install`へ変更している。これは**暫定対応**であり、AWS側の該当バグが修正され次第`npm ci`へ戻すこと。

**根本原因(リポジトリ側の問題ではない)**: `npm ci`が`Missing: @opentelemetry/core@2.0.0 from lock file`で失敗する。原因はAWSが公開している`@aws-amplify/data-construct`(最新1.17.7、直近の1.17.5/1.17.6でも同様)と`@aws-amplify/graphql-api-construct`(最新1.22.2)自体が、パッケージ内部にバンドル(vendoring)した`@opentelemetry/core`(バンドル版は2.8.0)と、同じくバンドルされた`@opentelemetry/resources`/`@opentelemetry/sdk-trace-base`(バンドル版は2.0.0で、内部的に`@opentelemetry/core@2.0.0`を厳密要求)との間で、バージョンが自己矛盾していること。実際に該当バージョンのtarballを取得・展開し、`node_modules/@opentelemetry/*/package.json`を直接確認して検証済み。

**なぜpackage.json/package-lock.jsonの修正で直せないか**: バンドル依存(`bundleDependencies`)はnpmパッケージのtarballに埋め込まれた固定内容であり、消費側(このリポジトリ)の`package.json`の`overrides`フィールドはバンドル依存には一切効果がない(npm公式の既知の制約)。`@aws-amplify/data-construct`を古いバージョン(バグの無い1.17.0など)へ強制ダウングレードする案も検討したが、`@aws-amplify/backend-data@1.8.0`は`^1.17.7`を要求しており、AWSが検証していない非対応の組み合わせになり実デプロイでのスキーマ生成に悪影響が出るリスクがあるため見送った(ユーザー判断済み)。

**なぜnpm installが安全か**: `npm install`は`npm ci`のような「ロックファイルの内部厳密整合性チェック」を行わないため、同じ壊れたバンドル依存があってもエラーにならず、実際にこのリポジトリで`node_modules`が正しく構築され`next build`まで成功することを確認済み。ローカル開発の運用方針(通常は`npm install`のまま)自体は変更していない — 変更したのは`amplify.yml`のAmplify Hostingビルド専用コマンドのみ。

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

Windows PowerShell + AWS CLIから一度に実行できるスクリプト一式を用意した(手作業のコマンド転記を最小化するため)。実行順序・安全上の注意は `scripts/aws-setup/README.md` を参照。全スクリプトASCII文字のみで記述している(日本語Windows環境でのWindows PowerShell 5.1のBOM無し.ps1文字化け問題を回避するため — 詳細は各スクリプト冒頭のコメント参照)。

1. `1-discover.ps1`(読み取り専用) — 現在のAWS identity(rootでないか確認)・region・既存Amplifyアプリ/ブランチ・SSRコンピュートロールらしきARN・Secretsの存在有無を一括確認する。何も変更しない。
2. `2-apply-secrets-policy.ps1`(書き込みあり、要確認プロンプト) — `1-discover.ps1`で特定したロール名を渡すと、Secrets Manager用の最小権限ポリシー(下記)を追加する。
3. `3-create-branch.ps1`(書き込みあり、要確認プロンプト) — 既存Amplifyアプリへ`claude/inventory-management-system-5vbvc7`ブランチを追加し、初回ビルドを開始する。
4. `4-create-app.ps1`(書き込みあり、要確認プロンプト) — Amplifyアプリがまだ存在しない場合に使う。`us-east-1`/`ap-northeast-1`/`us-west-2`の3リージョンを再確認して重複作成を避けたうえで、GitHub Personal Access Token(`--oauth-token`)を使いAWS CLIだけでアプリ作成・ブランチ追加・初回ビルド開始までを行う。**ユーザー本人にしかできない操作はGitHub PATの発行だけ**(下記§4a参照) — AWS Console上でのGitHubアプリ連携(複数画面のOAuth同意フロー)は不要になった。

**Amplifyアプリ自体がまだ存在しない場合**(`1-discover.ps1`が「見つかりませんでした」と表示した場合)は`4-create-app.ps1`を実行する。

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

## 4. Amplify Hostingブランチデプロイ

### 4a. CLIだけで完結する経路(推奨、`4-create-app.ps1`が自動化)

**訂正(初版からの修正)**: 初版では`--oauth-token`を使う設計にしていたが、これはGitHub以外のプロバイダ(Bitbucket・CodeCommit)専用のパラメータで、GitHubに対してAWSが現在公式に推奨しているのは「Amplify GitHub App」経由の`--access-token`方式であることが判明したため修正した([AWS CLI `create-app`リファレンス](https://docs.aws.amazon.com/cli/latest/reference/amplify/create-app.html)、[AWS公式アナウンス「AWS Amplify Hosting now uses a GitHub App」](https://aws.amazon.com/about-aws/whats-new/2022/04/aws-amplify-hosting-github-access-workflows/))。

この方式は次の2段階になる。両方ともユーザー本人のGitHubアカウントでの操作が必須(BLOCKED_BY_USER)だが、いずれも1回だけで済む単純な操作。

**手順1(1回だけ・ブラウザ): Amplify GitHub Appをインストール・認可する**
1. `https://github.com/apps/aws-amplify-us-east-1` を開く(Regionを変える場合はus-east-1の部分を置き換える — Amplify GitHub AppはRegionごとに別アプリとして提供されている)
2. GitHubへサインイン → **Install & Authorize**
3. 「Only select repositories」を選び `bello050401/aws-amplify-system` を選択(または「All repositories」)→ **Install & Authorize**

もしそのURLが404になる場合は、AWS ConsoleのAmplify → 「新しいアプリの作成」→「GitHubからデプロイ」→「GitHubで続行」の画面まで進むと、そのRegion用の正しいインストールURLへ自動的にリダイレクトされる(ここで実際にアプリを作成する必要はない — インストール画面まで進んだら一度ブラウザを閉じてよい)。

**手順2(1回だけ・ブラウザ): Classic PATを発行する**

GitHub → 右上アイコン → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**。

- 必ず **Classic token**(`ghp_`で始まるもの)を使う — Fine-grained tokenはAmplifyの`accessToken`では確実に動作しないことが報告されている。
- scopeは **`admin:repo_hook`** のみで発行する(AWS公式User Guideの案内に基づく必要最小限。`repo`フルスコープは要求しない)。
- もし手順3でAmplify側が権限不足のエラーを返す場合、AWS公式のフォールバックとして`repo`スコープの追加が案内されている — その場合のみ追加する。

発行したPATは`4-create-app.ps1`実行時のプロンプトへ貼り付ける(スクリプト内でSecureString化して扱い、画面表示・ログ・ファイル保存は一切行わない)。

**手順3(自動・スクリプト): `4-create-app.ps1`を実行**

内部で行うこと(すべてAWS CLI経由、確認プロンプトあり):
1. `us-east-1`・`ap-northeast-1`・`us-west-2`の3リージョンを再スキャンし、既存アプリが無いことを再確認(重複作成防止)
2. `aws amplify create-app --platform WEB_COMPUTE --access-token <PAT>` でアプリを作成(手順1でインストール済みのGitHub Appと組み合わせて使われる)
3. `aws amplify create-branch` で`claude/inventory-management-system-5vbvc7`を追加(`main`は対象外)
4. `aws amplify start-job --job-type RELEASE` で初回ビルドを開始

**未検証の注意点**: このClaude Code環境には実AWS認証情報・実GitHubアカウントが無いため、`--access-token`での接続を実機確認できていない。`4-create-app.ps1`はAWS CLIが返す生のエラーメッセージをそのまま表示するので、失敗した場合はそのメッセージを教えてもらえれば原因を特定して修正する。

### 4b. AWS Consoleでの代替手順(4aが失敗した場合のフォールバック)

1. AWS Console → **Amplify** → 「新しいアプリの作成」→「GitHubからデプロイ」
2. GitHubアカウント認可 → リポジトリ `bello050401/aws-amplify-system` を選択
3. ブランチとして `claude/inventory-management-system-5vbvc7` を選択(**mainは選択しない**)
4. ビルド設定はリポジトリ直下の `amplify.yml` がそのまま使われる(既存のGen2 + Next.js SSR標準構成、変更不要)
5. デプロイ実行 → 完了後、そのブランチ専用のURLが発行される

Amplifyアプリが既に存在する場合は、4a/4bのアプリ作成の代わりに`3-create-branch.ps1`をそのApp IDで実行すればよい。**重要**: どの経路でも別ブランチの追加であり、`main`ブランチの設定・本番ドメインには一切触れない。

### 4c. Amplify Gen2バックエンドとHosting Appの関係(重要)

Amplify Gen2では、Amplify Hostingの「ブランチ」ごとに**独立したバックエンド環境**(専用のCognito User Pool・AppSync API・S3バケット)が作られる — `amplify.yml`のbackendフェーズが実行する`ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID`が、ブランチ名をキーにCloudFormationスタックを作成/更新する仕組みのため。

このリポジトリはこれまで一度もAmplify Hostingへ接続されたことが無い(`1-discover.ps1`でus-east-1に既存アプリが無いことを確認済み、`4-create-app.ps1`で他2リージョンも再確認する)。つまり:

- 今回`claude/inventory-management-system-5vbvc7`ブランチ用に作られるCognito/AppSync/S3は、**このアプリにとって初めてのHosting経由バックエンド**であり、既存の本番リソースを上書き・共有することは無い(そもそも存在しない)。
- 将来`main`を別途Amplify Hostingへ接続して本番運用する場合も、Gen2の「ブランチ=独立バックエンド」の仕組みにより、今回作成したテスト用バックエンドとは完全に分離された別のCognito/AppSync/S3が新たに作られる — 今回の作業が将来の本番環境構築を妨げたり、リソースを共有してしまったりすることは無い。
- ローカル開発者が各自`ampx sandbox`で使っている個人サンドボックス環境(一時的、`.amplify/`はgitignore対象)とも完全に別物 — 混同しないこと。

## 5. ZAICO少数件テスト同期(コード実装済み)

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

## 8. 公開URLの404問題(調査結果・修正手順は`scripts/aws-setup/5-fix-404-and-redeploy.ps1`/`6-create-staging-app.ps1`)

**訂正(初版からの重要な修正)**: 初版では「このAmplifyアプリ(`d1uy61lbnqm8ae`)はテストブランチ専用で`main`は接続されていない」と誤認識しており、`update-app --platform WEB_COMPUTE`を直接このAppへ適用する設計にしていた。**実際にはこのAppには`main`が本番(PRODUCTION)ブランチとして既に存在しており**、`platform`はApp単位の設定のため、そのまま適用すると本番へ影響するリスクがあった。ユーザーの指摘により、**既存App(`d1uy61lbnqm8ae`)には一切変更を加えず、`platform=WEB_COMPUTE`を最初から指定した別の新規staging専用Amplify Appを作成する方式**へ修正した。`5-fix-404-and-redeploy.ps1`は読み取り専用の診断のみに変更し、実際の修正は`6-create-staging-app.ps1`(新規App作成)が行う。

### 8a. 調査の前提(このClaude Code環境の制約)

このセッションからは実AWS CLI・実AWS認証情報が利用できず、また公開URL(`*.amplifyapp.com`)自体もこのサンドボックスのネットワークegressプロキシにブロックされており直接curl確認もできない。そのため以下の根本原因はコードベース側の証拠(このリポジトリの`next.config.js`・`amplify.yml`・ローカルでの`next build`成果物構造)とAWS公式ドキュメント・調査記事の記述から特定したもので、`scripts/aws-setup/5-fix-404-and-redeploy.ps1`の実行結果(特にstep 2のビルド成果物ZIP実地確認)で最終的に裏付けを取ること。

### 8b. 根本原因(推測ではなく切り分け済み)

ユーザー報告の事実(`branch framework = null`、`app platform = WEB`)と、このリポジトリの実際の`next build`出力(`.next/server/`ディレクトリが存在し、`/`と`/_not-found`以外の全ルートが`ƒ (Dynamic) server-rendered on demand`)を突き合わせた結果:

- **原因はAmplifyアプリの`platform`設定が`WEB`(静的サイト専用ホスティング)のままになっていること**。AWS公式ドキュメント(下記出典)によれば、Next.js 14以降はSSR/SSGを問わず`platform=WEB_COMPUTE`が必須(Next.js 12〜13のSSRは`WEB_DYNAMIC`という別の中間platformだったが、14以降は`WEB_COMPUTE`のみがサポート対象)。
- `platform=WEB`のままだと、Amplifyは`.next`ビルド成果物を素の静的ファイル群として扱おうとするが、Next.jsのSSRビルドには静的ホスティングが必要とする`index.html`がルートに存在せず(`.next/server/`配下にサーバーサイドレンダリング用のファイルがあるのみ)、Next.js自身のルーティング/レンダリングを実行するサーバーランタイムも存在しないため、どのパスへのリクエストも配信すべき実体が見つからず404になる。
- `branch framework = null`は、Amplifyがこのアプリを正しくNext.js SSRアプリとして認識できていない結果の表れ(`platform=WEB_COMPUTE`かつ`framework="Next.js - SSR"`が正しい組み合わせ)。
- 切り分けた結果、以下は原因ではないと判断: `amplify.yml`の`baseDirectory: .next`/`files: ['**/*']`設定自体は`platform=WEB_COMPUTE`向けの標準的な設定として正しい(AWS公式のNext.js SSR用`amplify.yml`テンプレートと同じ形)。App Router構成・build出力先も問題なし。SPA向けcustomRuleの影響ではない(customRule自体を設定していない)。branch/URLマッピング自体は存在している(job 5がSUCCEEDしている以上、ビルド・デプロイ自体は成功しており「デプロイされたが何を配信すべきか分からない」状態)。

### 8c. なぜ既存Appを変更せず、新規App作成という方針にしたか

`platform`はApp単位の設定であり、既存App(`d1uy61lbnqm8ae`)には`main`が本番ブランチとして既に存在するため、既存Appのplatformを変更すると本番へ影響するリスクがある。したがって:

- 既存App(`d1uy61lbnqm8ae`)・`main`ブランチには一切変更を加えない(`5-fix-404-and-redeploy.ps1`は読み取り専用診断のみに変更済み)。
- `6-create-staging-app.ps1`が、`platform=WEB_COMPUTE`を最初から指定した**別の新規staging専用Amplify App**を作成し、テスト用ブランチ(`claude/inventory-management-system-5vbvc7`)だけを接続する。新Appには`main`を一切追加しない。
- 既存の`BelloAmplifyBackendDeploymentRole`(Amplify backendデプロイ用IAMロール)は読み取り専用で存在確認したうえで新Appへ再利用を**試みた**(ロール自体への変更は行わない方針だった)。**訂正: この再利用は実際には失敗した — 詳細は下記§9参照。**
- CDK bootstrap(us-west-2)はアカウント/リージョン単位のリソースであり、Amplify App単位ではないため、新規App用に再実行する必要はない。

### 8d. 出典

- [Amplify support for Next.js - AWS Amplify Hosting](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html)
- [Migrating a Next.js 11 SSR app to Amplify Hosting compute](https://docs.aws.amazon.com/amplify/latest/userguide/update-app-nextjs-version.html)
- [How to Update Amplify Platform and Framework Settings from the CLI - NakoBase](https://nakobase.com/en/nakobase-knowledge/amplify-update-platform-and-framework)

## 9. staging Appのビルドが `Unable to assume specified IAM Role` で失敗した問題(修正: `scripts/aws-setup/7-fix-staging-iam-role.ps1`)

`6-create-staging-app.ps1`で新規staging App(`d4hkkg7dty2du`、us-west-2)を作成した際、既存の`BelloAmplifyBackendDeploymentRole`のARNをそのまま`--iam-service-role-arn`として再利用したが、最初のRELEASE job(jobId=1)がBUILDステップで以下のエラーによりFAILEDした:

```
Unable to assume specified IAM Role.
Please ensure the selected IAM Role has sufficient permissions and the Trust Relationship is configured correctly.
```

### 9a. 根本原因

`BelloAmplifyBackendDeploymentRole`のTrust PolicyはAssumeRoleの条件(`aws:SourceArn`)を既存の本番App(`d1uy61lbnqm8ae`)のARNだけに限定して発行されていた。そのため、新規staging App(`d4hkkg7dty2du`)からのAssumeRoleリクエストはTrust Policyの条件に合致せず拒否され、Amplify側にはこれが「ロールをassumeできない」という上記メッセージとして表れる。ロールのIAMポリシー(権限)自体の不足ではなく、Trust Policy(誰がこのロールをassumeできるか)側の制限が原因だった。

### 9b. 修正方針

既存の本番ロール`BelloAmplifyBackendDeploymentRole`のTrust Policyを緩めて両方のAppを許可する案は採用しなかった(本番用ロールの権限境界を広げることになり、本番へのリスクを増やすため)。代わりに、staging専用の新しいIAMロール`BelloAmplifyStagingBackendDeploymentRole`を作成し、Trust PolicyのSourceArn条件をstaging App自身のARN(`arn:aws:amplify:us-west-2:203918843421:apps/d4hkkg7dty2du/branches/*`)だけに限定した。既存の本番ロールは読み取り専用でattached managed policy / inline policyを調査し、その内容(既存が`AdministratorAccess-Amplify`のような広いmanaged policyを使っている場合はそれを含む)を新しいstaging専用ロールへ複製した。理由: 初期構築段階で権限不足によるビルド失敗を避けるため、production側と同水準の権限を暫定的に付与しているが、ロール自体はTrust Policyでstaging Appのみからしかassumeできないよう分離されているため、本番への影響はない。将来的にstagingの動作確認が完了した後、権限を絞り込むことが望ましい(TODO)。

staging Appの`iamServiceRoleArn`だけを新ロールへ更新し(他の設定は一切変更しない)、branchが対象の1本だけであることを確認したうえで新しいRELEASE buildを開始する。IAMの変更(ロール作成・ポリシーアタッチ)は反映まで数秒〜数十秒のラグが生じることがあり、これによる`Unable to assume specified IAM Role`の再発は設定ミスではなく一時的な伝播待ちであるため、`7-fix-staging-iam-role.ps1`はビルドログに同一エラー文言を検出した場合、追加待機のうえ自動的に最大3回までリトライする。

### 9c. 実施した安全対策

- 既存本番App(`d1uy61lbnqm8ae`)・本番ロール(`BelloAmplifyBackendDeploymentRole`)には一切変更を加えない(読み取りのみ)。
- `main`ブランチには一切触れない。
- 新規ロールのTrust Policyはstaging App自身のARNだけに限定されており、本番Appからはassumeできない。
- スクリプトは既存App ID(`d1uy61lbnqm8ae`)を対象とするAWS CLI呼び出しを検出した場合、実行前に必ず中断する安全策を内蔵している。

### 9d. 追記: Trust Policy JSONが `MalformedPolicyDocument` で拒否された問題

`7-fix-staging-iam-role.ps1`の初版実行時、`create-role`が以下で失敗した:

```
An error occurred (MalformedPolicyDocument) when calling the CreateRole operation: This policy contains invalid Json
```

**原因**: PowerShellの`ConvertTo-Json`自体は正しいJSONを生成していたが、それを`--assume-role-policy-document`へ**インラインのコマンドライン引数としてそのまま渡していた**ことが問題だった。Trust PolicyのようなJSONは二重引用符・波括弧・コロンを大量に含む長い文字列であり、Windowsのネイティブプロセス引数渡し(`CommandLineToArgvW`。PowerShellの`& 外部コマンド @配列`によるsplattingも最終的にこれを経由する)は、こうした文字列の再クォート・エスケープ処理でJSONを破損させることが知られている。AWS公式CLIドキュメントがWindows環境でポリシードキュメントに`file://`形式を推奨しているのはこのためであり、単純な短いGitHub PAT文字列(英数字とアンダースコアのみ)を渡した時には問題が起きなかったのとは対照的である。

**修正**: Trust Policy(および複製する各inline policy)を一時JSONファイルへUTF-8(BOM無し、`[System.IO.File]::WriteAllText`+明示的な`UTF8Encoding($false)`で書き込み — Windows PowerShell 5.1の`-Encoding utf8`はBOM付きで書き込むため使用しない)として書き出し、書き込み前に`ConvertFrom-Json`で再パース検証したうえで、`--assume-role-policy-document file://<一時ファイルパス>`の形式でAWS CLIへ渡すよう変更した。一時ファイルは`$env:TEMP`配下に作成され、Git管理対象には含まれず、使用後は`finally`ブロックで必ず削除される。Trust Policyの構造(Version/Effect/Principal.Service/Action/Condition — App IDやARNを含むがシークレットは含まない)は、AWS CLI呼び出し前にコンソールへ安全に表示される。

### 9e. 注記: Secrets Manager用Compute Roleとの違い

このBackend Deployment Role(`ampx pipeline-deploy`がCloudFormationスタックをデプロイする際に使うロール)は、Next.js SSRのランタイムがSecrets Managerからシークレットを読み取る際に使う「Compute Role」とは別物である。Compute Roleの設定は、staging Appの公開URLが正常に表示されることを確認した後の次工程として、`2-apply-secrets-policy.ps1`を該当Compute Roleへ対して実行する形で行う(§4参照)。

## 10. staging backend deployが `AWS::SecretsManager::Secret ... AlreadyExists` でrollbackした問題(本当の根本原因・修正: `amplify/backend.ts`)

IAM Role修正(§9)の後、staging backendのCloudFormationデプロイが実際に開始され、backend synth・型チェック・assetsのbuild/publishまで進んだが、以下で最初の実質的な失敗が発生し、デプロイ全体がrollbackした(実ログで確認済み):

```
AWS::SecretsManager::Secret
ZaicoTokenSecretStack/ZaicoApiTokenSecret

CREATE_FAILED

Resource handler returned message:
"The operation failed because the secret bello/zaico-api-token already exists."

HandlerErrorCode: AlreadyExists
```

この失敗より後に表示されたCognito Group Role群(EDITOR/VIEWER/ADMIN)・`authenticatedUserRole`/`unauthenticatedUserRole`・`SkuCounterTable`等のCREATE_FAILED(`Resource creation cancelled`)、および最終的な`[UnknownFault] NoStack`エラーは、**全てこの1件のSecret作成失敗に伴う二次的なrollback結果**であり、個別に修正すべき別問題ではない(WEB_COMPUTE設定・Next.js SSR対応・IAM AssumeRole・CDK bootstrapのいずれにも問題は無かった)。

### 10a. 根本原因

`amplify/backend.ts`が`new Secret(zaicoTokenSecretStack, "ZaicoApiTokenSecret", { secretName: "bello/zaico-api-token", ... })`という形で、このSecretをCloudFormationが所有する**新規作成resource**として定義していた。この定義はproduction App(`d1uy61lbnqm8ae`、`main`)がbackendを最初にデプロイした時点で実際にAWSアカウント上へこのSecretを作成済みであり、それ以降 `bello/zaico-api-token` は(コード上の定義とは裏腹に)実質的に「既存の外部リソース」になっていた。

ところが同じ`amplify/backend.ts`は全ブランチの`ampx pipeline-deploy`が共有するファイルであり、新しく作成した専用staging App(`d4hkkg7dty2du`、`claude/inventory-management-system-5vbvc7`)がbackendを初回デプロイした際にも同じ`new Secret(...)`定義が評価され、CloudFormationが同名のSecretを新規CREATEしようとして衝突した。これはproduction/staging間のIAM・platform・framework等の設定差とは無関係の、**IaC定義そのものの設計ミス**(共有コードで環境ごとに異なる既存/非既存の外部状態を仮定していた)だった。

### 10b. 修正前のSecret lifecycle

- Secretリソースの所有者: `amplify/backend.ts`(CDK/CloudFormation)。`new Secret(...)`で新規作成・`RemovalPolicy.RETAIN`・初期値`{"configured":false}`を明示的に設定。
- 新しい環境(新規Amplify App)でbackendを初回デプロイするたびに、CloudFormationは同名のSecretを新規作成しようとする(既存の場合は衝突・失敗)。
- アプリ側(`lib/zaico/secretStore.ts`)はCreateSecretフォールバック(`PutSecretValue`が`ResourceNotFoundException`を返した場合のみ)も持っており、「CDKが所有」と「アプリが所有」の2つの作成経路が同時に存在していた。

### 10c. 修正後のSecret lifecycle

- Secretリソースの所有者: **AWSアカウント側の既存の外部リソース**。CDK/CloudFormationはこれを作成・削除・rename一切しない。
- `amplify/backend.ts`は`Secret.fromSecretNameV2(backend.stack, "ZaicoApiTokenSecret", "bello/zaico-api-token")`でこのSecretを**参照(import)するだけ**に変更した。CDKのfrom*系メソッドは対応する`AWS::SecretsManager::Secret`のCloudFormation resourceを一切生成しない(合成時の参照のみ)ため、どの環境・どのAmplify Appでbackendを新規デプロイしても、このSecretを再作成しようとして衝突することはなくなった。
- `RemovalPolicy.RETAIN`と初期値`secretStringValue`の設定は削除した(どちらもCDKがリソースを所有する場合にのみ意味を持ち、importされた既存リソースには適用できない設定だったため)。
- アプリ側(`lib/zaico/secretStore.ts`)のCreateSecretフォールバックはコードとしては残しているが、通常運用ではSecretが常に既存の外部リソースとして存在する前提になったため、実際に呼ばれることは無い防御的コードという位置づけに変わった(ファイル冒頭コメントを更新済み)。
- SSRコンピュート実行ロールへ付与するIAM権限からも`CreateSecret`を外した(`2-apply-secrets-policy.ps1`。付与するのは`GetSecretValue`・`PutSecretValue`のみ)。

### 10d. Secretの実際のRegion・ARN

`bello/zaico-api-token`は`us-west-2`に実在することを確認した(production App `d1uy61lbnqm8ae`・staging App `d4hkkg7dty2du`が共にus-west-2にデプロイされていることと整合し、staging backendの初回デプロイが**まさにus-west-2上で**`AlreadyExists`エラーを返したこと自体が、このリージョンに実在する直接的な証拠になっている — 別リージョンだったならCloudFormationはこのエラーを返さない)。`lib/zaico/secretStore.ts`のリージョンfallbackも、根拠のない`us-east-1`から実際のデプロイ先である`us-west-2`へ修正した(Amplify Hosting上のSSRコンピュート実行環境では`AWS_REGION`が自動設定されるため、このfallback値はローカル開発端末で`AWS_REGION`未設定の場合にのみ効いてくる)。ARN・実在確認は`scripts/aws-setup/8-diagnose-zaico-secret.ps1`(読み取り専用、`describe-secret`のみ、値は取得しない)で確認できる。

### 10e. 修正したAmplify build log取得バグ(byte配列表示)

`scripts/aws-setup/7-fix-staging-iam-role.ps1`(および同じパターンを持っていた`6-create-staging-app.ps1`)は、失敗したbuild stepのログをWindows PowerShell 5.1の`Invoke-WebRequest -UseBasicParsing`で取得していたが、レスポンスのContent-Typeがテキストと認識されない場合、`.Content`が文字列ではなく生の`byte[]`として返ってくることがある。これを`Write-Host`へそのまま渡すと、各バイトが10進数として1つずつ表示され(「50 48 50 54 45 ...」のような出力)、障害解析が事実上不可能になっていた。

修正: `ConvertTo-DecodedLogText`関数を追加し、`.Content`が`byte[]`の場合はgzipマジックバイト(`0x1f 0x8b`)を検出して必要に応じて解凍したうえで、明示的にUTF-8としてデコードして人間が読めるテキストへ変換するようにした(文字列で返ってきた場合はそのまま使う)。あわせて、失敗ログ全体を一時ファイル(`$env:TEMP`配下、Git管理対象外、スクリプト終了時に削除)へ保存できるようにし、`Find-FirstMeaningfulFailure`関数で末尾の汎用的な「Build failed」バナーだけに頼らず、`CREATE_FAILED`・`HandlerErrorCode`・`AlreadyExists`等のマーカーに最初に一致した行(と前後の文脈)を自動抽出するようにした。

## 11. preflightがSecretを「存在しない」と誤判定した問題(cp932エンコードエラー、修正: `7-fix-staging-iam-role.ps1`・`8-diagnose-zaico-secret.ps1`)

§10で追加したpreflightのSecret存在確認を実際に実行したところ、AWS CLI自体は`bello/zaico-api-token`を正しく発見していた(実際の出力にARN`arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/zaico-api-token-6B6S6P`が表示されている)にもかかわらず、直後に以下のエラーで異常終了し、preflightがこれを「Secret not found」と誤判定した:

```
System.Management.Automation.RemoteException
aws: [ERROR]: 'cp932' codec can't encode character '—' in position 15: illegal multibyte sequence
```

### 11a. 根本原因

`describe-secret`はSecretを発見できていたが、AWS CLI(Python製)がそのSecretの`Description`フィールドに含まれるUnicode文字(EM DASH、U+2014)を、Windows PowerShell 5.1のコンソール(cp932コードページ)へ出力しようとしてエンコードエラーを起こしていた。これは「Secretが存在するかどうか」とは無関係な、**出力のエンコード処理そのものの失敗**であり、そのnon-zero終了コードを、修正前のスクリプトが単純に「AWS CLI呼び出し失敗 = Secret不存在」と丸めて誤判定していた。Secretは最初から一貫して存在していた。

### 11b. 修正後のSecret存在確認方式

`describe-secret`に`--query "{ARN:ARN,Name:Name}"`を指定し、AWS CLI自身に`ARN`と`Name`(共にASCIIのみ)だけを取得・出力させるよう変更した。`Description`・`Tags`等、任意のUnicodeを含み得るフィールドはAWS CLIの出力処理に一切渡らなくなるため、今回と同種のエンコードエラーはこの経路では原理的に再発しない。

あわせて、AWS CLI呼び出しが失敗した場合に何が失敗したのかを分類する`Get-AwsErrorKind`関数を追加した(第二の防御層):

- `ResourceNotFoundException`を含む場合のみ`not-found`と判定する。
- `AccessDenied`・認証情報エラー・encodingエラー(`codec can't encode`等)は、それぞれ別の種類の失敗として報告し、**いずれも「Secret不存在」とは判定しない**。

この2つの修正を`7-fix-staging-iam-role.ps1`のpreflightと`8-diagnose-zaico-secret.ps1`の両方に適用した。

### 11c. CloudFormation stabilization wait

同じpreflight実行で、staging App配下の以下のCloudFormation stackが`*_IN_PROGRESS`状態であることも確認された:

```
amplify-d4hkkg7dty2du-...-storage...  : CREATE_IN_PROGRESS
amplify-d4hkkg7dty2du-...-function... : CREATE_COMPLETE
amplify-d4hkkg7dty2du-...-SkuCounterStack... : CREATE_COMPLETE
amplify-d4hkkg7dty2du-...-auth...     : CREATE_COMPLETE
amplify-d4hkkg7dty2du-...root...      : CREATE_IN_PROGRESS
```

`*_IN_PROGRESS`のstackが残っている状態で新しいRELEASE buildを開始すると、CloudFormationが同一stackへの同時更新を拒否する可能性があるため、`7-fix-staging-iam-role.ps1`のpreflightへ**stabilization wait**を追加した: 対象stackのいずれかが`_IN_PROGRESS`状態である間、20秒間隔・最大約20分、`describe-stacks`(`StackStatus`のみを`--query`で取得)をポーリングし続け、全てが終端状態(`CREATE_COMPLETE`等の成功系、または`ROLLBACK_COMPLETE`等の失敗系)になってから初めてビルド開始の判断へ進む。終端状態が失敗系だった場合は`describe-stack-events`を読み、最初の実質的な`*_FAILED`イベント(`LogicalResourceId`/`ResourceType`/`ResourceStatusReason`)を自動抽出して表示する。`ROLLBACK_COMPLETE`のstackに対しては`delete-stack`を能動的に呼ばない(次の`ampx pipeline-deploy`が通常のCDK deployの一部として自動的にクリーンアップするため)。既存Secretはどちらの経路でも削除・再作成されない(§10の修正によりCloudFormationはこのSecretを一切所有していないため)。

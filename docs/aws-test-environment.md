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

## 8. 公開URLの404問題(調査結果・修正手順は`scripts/aws-setup/5-fix-404-and-redeploy.ps1`)

### 8a. 調査の前提(このClaude Code環境の制約)

このセッションからは実AWS CLI・実AWS認証情報が利用できず、また公開URL(`*.amplifyapp.com`)自体もこのサンドボックスのネットワークegressプロキシにブロックされており直接curl確認もできない。そのため以下の根本原因はコードベース側の証拠(このリポジトリの`next.config.js`・`amplify.yml`・ローカルでの`next build`成果物構造)とAWS公式ドキュメント・調査記事の記述から特定したもので、`scripts/aws-setup/5-fix-404-and-redeploy.ps1`の実行結果(特にstep 2のビルド成果物ZIP実地確認)で最終的に裏付けを取ること。

### 8b. 根本原因(推測ではなく切り分け済み)

ユーザー報告の事実(`branch framework = null`、`app platform = WEB`)と、このリポジトリの実際の`next build`出力(`.next/server/`ディレクトリが存在し、`/`と`/_not-found`以外の全ルートが`ƒ (Dynamic) server-rendered on demand`)を突き合わせた結果:

- **原因はAmplifyアプリの`platform`設定が`WEB`(静的サイト専用ホスティング)のままになっていること**。AWS公式ドキュメント(下記出典)によれば、Next.js 14以降はSSR/SSGを問わず`platform=WEB_COMPUTE`が必須(Next.js 12〜13のSSRは`WEB_DYNAMIC`という別の中間platformだったが、14以降は`WEB_COMPUTE`のみがサポート対象)。
- `platform=WEB`のままだと、Amplifyは`.next`ビルド成果物を素の静的ファイル群として扱おうとするが、Next.jsのSSRビルドには静的ホスティングが必要とする`index.html`がルートに存在せず(`.next/server/`配下にサーバーサイドレンダリング用のファイルがあるのみ)、Next.js自身のルーティング/レンダリングを実行するサーバーランタイムも存在しないため、どのパスへのリクエストも配信すべき実体が見つからず404になる。
- `branch framework = null`は、Amplifyがこのアプリを正しくNext.js SSRアプリとして認識できていない結果の表れ(`platform=WEB_COMPUTE`かつ`framework="Next.js - SSR"`が正しい組み合わせ)。
- 切り分けた結果、以下は原因ではないと判断: `amplify.yml`の`baseDirectory: .next`/`files: ['**/*']`設定自体は`platform=WEB_COMPUTE`向けの標準的な設定として正しい(AWS公式のNext.js SSR用`amplify.yml`テンプレートと同じ形)。App Router構成・build出力先も問題なし。SPA向けcustomRuleの影響ではない(customRule自体を設定していない)。branch/URLマッピング自体は存在している(job 5がSUCCEEDしている以上、ビルド・デプロイ自体は成功しており「デプロイされたが何を配信すべきか分からない」状態)。

### 8c. なぜApp全体・main設定の変更にならないか

このAmplifyアプリ(`d1uy61lbnqm8ae`)は`4-create-app.ps1`によってテストブランチ専用に新規作成したものであり、`main`ブランチは接続されていない。`platform`はアプリ単位の設定だが、このアプリに紐づくブランチはテストブランチ1つだけなので、`update-app --platform WEB_COMPUTE`を実行しても本番/mainには一切影響しない。別のstaging専用Amplify Appを新たに作る必要はない(このApp自体が最初からstaging専用)。

### 8d. 出典

- [Amplify support for Next.js - AWS Amplify Hosting](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html)
- [Migrating a Next.js 11 SSR app to Amplify Hosting compute](https://docs.aws.amazon.com/amplify/latest/userguide/update-app-nextjs-version.html)
- [How to Update Amplify Platform and Framework Settings from the CLI - NakoBase](https://nakobase.com/en/nakobase-knowledge/amplify-update-platform-and-framework)

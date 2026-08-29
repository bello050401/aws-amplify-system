# BELLO AWSテスト環境セットアップスクリプト

このディレクトリのスクリプトは、Windows PowerShell + AWS CLI から実行する前提。Claude Codeのサンドボックス環境には実AWS認証情報が無いため、これらは**ユーザーPC側で**実行する。

実行順序:

1. **`1-discover.ps1`**(読み取り専用、安全) — 現在のAWS identity・region・Amplifyアプリ/ブランチ・Secretの存在有無を確認し、次に何をすべきかを画面に表示する。何も変更しない。
2. **Amplifyアプリが既に見つかった場合** → **`3-create-branch.ps1`**(書き込みあり) — 既存のAmplifyアプリへ`claude/inventory-management-system-5vbvc7`ブランチを追加し、初回ビルドを開始する。
   **Amplifyアプリが見つからなかった場合** → **`4-create-app.ps1`**(書き込みあり) — 他の主要リージョンも再確認したうえで、`--access-token`(AWS公式のGitHub App接続方式)を使いAWS CLIだけでアプリ作成・ブランチ追加・初回ビルド開始までを行う。必要な本人操作は2つだけ: (a) 対象RegionのAmplify GitHub Appを`https://github.com/apps/aws-amplify-<region>`から1回インストール・認可、(b) `admin:repo_hook`スコープのClassic PATを1回発行してスクリプトへ貼り付け。詳細は`docs/aws-test-environment.md`§4a参照。
3. **`2-apply-secrets-policy.ps1`**(書き込みあり) — 上記で分かった(または`4-create-app.ps1`実行後にAmplify Consoleで確認する)SSR実行ロールへ、Secrets Manager用の最小権限インラインポリシーを追加する。ロール名を引数で渡す。
4. **公開URLが404になる場合** → **`5-fix-404-and-redeploy.ps1`**(読み取り専用、安全) — Amplifyアプリの`platform`がWEB(静的サイト専用)のままになっているのが典型的な原因(Next.js 14以降はSSR/SSGを問わず`platform=WEB_COMPUTE`が必須、AWS公式ドキュメントに明記)。実際のビルド成果物ZIPをダウンロードして中身を確認し、当該Appに`main`等の他ブランチ(=本番)が存在するかどうかを表示するだけで、**このAppへは一切変更を加えない**(platformはApp単位の設定であり、本番ブランチが同じAppに存在する場合は変更すると本番へ影響し得るため)。
5. **上記でplatform不整合が確認され、かつ既存Appに本番ブランチが同居している場合** → **`6-create-staging-app.ps1`**(書き込みあり) — 既存Appには一切触れず、`platform=WEB_COMPUTE`を最初から指定した**別の新規staging専用Amplify App**を作成し、テスト用ブランチだけを接続、初回ビルド開始・完了までポーリング・失敗時ログ取得・成功時HTTPアクセス確認まで一括で行う。既存の`BelloAmplifyBackendDeploymentRole`を読み取り専用で確認し、存在すれば新Appのbackendデプロイロールとして再利用する(ロール自体は変更しない)。詳細は`docs/aws-test-environment.md`§8参照。
6. **`6-create-staging-app.ps1`のビルドが`Unable to assume specified IAM Role`で失敗した場合**(既存の`BelloAmplifyBackendDeploymentRole`は本番Appのみに限定されたTrust Policyを持つため、新規staging Appからはassumeできない) → **`7-fix-staging-iam-role.ps1`**(書き込みあり) — staging専用の新規ロール`BelloAmplifyStagingBackendDeploymentRole`を作成し、Trust PolicyのSourceArnをstaging App自身のARNだけに限定する。既存の本番ロールは読み取り専用でattached/inline policyを調査するだけで、変更は一切行わない。staging Appの`iamServiceRoleArn`だけを新ロールへ更新し、ビルドを自動再実行・ポーリングする(IAM反映待ちによる同一エラーの再発は自動リトライする)。詳細は`docs/aws-test-environment.md`§9参照。

## 前提

- AWS CLIがインストール済みであること(`aws --version`)。
- AWS SSOプロファイル(例: `Bello`)でログイン済みであること。未ログインの場合:
  ```powershell
  aws sso login --profile Bello
  ```
- 各スクリプトは `-ProfileName` / `-Region` 引数を受け取る(既定値: `Bello` / `us-east-1` — `5-fix-404-and-redeploy.ps1`と`6-create-staging-app.ps1`のみ既定Regionは`us-west-2`、実際のApp作成先に合わせてある)。

## 安全上の注意

- どのスクリプトも `main` ブランチやproductionリソースには一切触れない。
- `1-discover.ps1`・`5-fix-404-and-redeploy.ps1` はAWSリソースを一切変更しない(読み取りAPIのみ)。
- `6-create-staging-app.ps1`・`7-fix-staging-iam-role.ps1`はいずれも既存App ID(`d1uy61lbnqm8ae`)を対象とするAWS CLI呼び出しを検出した場合、実行前に必ず中断する安全策(defense in depth)を内蔵している — 既存の本番Appを誤って変更することはできない設計になっている。
- `7-fix-staging-iam-role.ps1`は既存の本番ロール`BelloAmplifyBackendDeploymentRole`を読み取り専用でしか参照しない(attached/inline policyの一覧取得のみ)。新規作成する`BelloAmplifyStagingBackendDeploymentRole`のTrust Policyは、staging App自身のARN(`arn:aws:amplify:<region>:<account>:apps/<staging-app-id>/branches/*`)だけに限定されており、本番Appからassumeすることはできない。
- `aws sts get-caller-identity` の結果が `arn:aws:iam::<account>:root` を含む場合、各スクリプトは警告を表示して停止する — root credentialsでのIAM操作は行わないこと。IAMユーザーまたはSSO経由のロールへ切り替えてから再実行する。

# BELLO AWSテスト環境セットアップスクリプト

このディレクトリのスクリプトは、Windows PowerShell + AWS CLI から実行する前提。Claude Codeのサンドボックス環境には実AWS認証情報が無いため、これらは**ユーザーPC側で**実行する。

実行順序:

1. **`1-discover.ps1`**(読み取り専用、安全) — 現在のAWS identity・region・Amplifyアプリ/ブランチ・Secretの存在有無を確認し、次に何をすべきかを画面に表示する。何も変更しない。
2. **Amplifyアプリが既に見つかった場合** → **`3-create-branch.ps1`**(書き込みあり) — 既存のAmplifyアプリへ`claude/inventory-management-system-5vbvc7`ブランチを追加し、初回ビルドを開始する。
   **Amplifyアプリが見つからなかった場合** → **`4-create-app.ps1`**(書き込みあり) — 他の主要リージョンも再確認したうえで、`--access-token`(AWS公式のGitHub App接続方式)を使いAWS CLIだけでアプリ作成・ブランチ追加・初回ビルド開始までを行う。必要な本人操作は2つだけ: (a) 対象RegionのAmplify GitHub Appを`https://github.com/apps/aws-amplify-<region>`から1回インストール・認可、(b) `admin:repo_hook`スコープのClassic PATを1回発行してスクリプトへ貼り付け。詳細は`docs/aws-test-environment.md`§4a参照。
3. **`2-apply-secrets-policy.ps1`**(書き込みあり) — 上記で分かった(または`4-create-app.ps1`実行後にAmplify Consoleで確認する)SSR実行ロールへ、Secrets Manager用の最小権限インラインポリシーを追加する。ロール名を引数で渡す。
4. **公開URLが404になる場合** → **`5-fix-404-and-redeploy.ps1`**(読み取り専用、安全) — Amplifyアプリの`platform`がWEB(静的サイト専用)のままになっているのが典型的な原因(Next.js 14以降はSSR/SSGを問わず`platform=WEB_COMPUTE`が必須、AWS公式ドキュメントに明記)。実際のビルド成果物ZIPをダウンロードして中身を確認し、当該Appに`main`等の他ブランチ(=本番)が存在するかどうかを表示するだけで、**このAppへは一切変更を加えない**(platformはApp単位の設定であり、本番ブランチが同じAppに存在する場合は変更すると本番へ影響し得るため)。
5. **上記でplatform不整合が確認され、かつ既存Appに本番ブランチが同居している場合** → **`6-create-staging-app.ps1`**(書き込みあり) — 既存Appには一切触れず、`platform=WEB_COMPUTE`を最初から指定した**別の新規staging専用Amplify App**を作成し、テスト用ブランチだけを接続、初回ビルド開始・完了までポーリング・失敗時ログ取得・成功時HTTPアクセス確認まで一括で行う。既存の`BelloAmplifyBackendDeploymentRole`を読み取り専用で確認し、存在すれば新Appのbackendデプロイロールとして再利用する(ロール自体は変更しない)。詳細は`docs/aws-test-environment.md`§8参照。
6. **staging環境を実際にデプロイ・監視・診断したい場合(通常はここから開始してよい。何度実行しても安全)** → **`7-fix-staging-iam-role.ps1`**(書き込みあり) — 冪等なstagingデプロイランナー。ファイル名は過去の経緯(元はIAM修正専用スクリプト)によるものだが、内部は12段階のstate machineとして再設計されている:
   1. `AWS_AUTH` — identity/account確認。accountが203918843421以外なら停止。SSO期限切れの場合のみ`aws sso login --profile Bello`だけを表示して停止(`BLOCKED_BY_USER`)。
   2. `ENVIRONMENT_VALIDATE` — App名/platform/framework/branch(mainが同居していないこと)を確認。
   3. `IAM_VALIDATE` — staging専用ロールが既に正しい状態なら`IAM already configured - OK`として何もせず通過。ロール未作成・Trust Policy不一致・App紐付け不一致の場合のみ、対話promptなしで自動修復する(production roleは読み取り専用参照のみ)。
   4. `SECRET_VALIDATE` — `bello/zaico-api-token`の存在をARN/Nameのみで確認(Descriptionは取得しない — cp932エンコードエラー対策)。`ResourceNotFoundException`の場合のみ不存在と判定。
   5. `CLOUDFORMATION_STABILIZE` — staging Appに属するCloudFormation stackに`*_IN_PROGRESS`が無いことを確認し、あれば安定するまで待機(20秒間隔、最大約25分)。
   6-7. `AMPLIFY_JOB_DISCOVER` / `AMPLIFY_JOB_ATTACH_OR_START` — **今回の最重要修正**: 既存のPENDING/PROVISIONING/RUNNING jobがあれば新規jobを開始せずそのjobへattachする。無い場合のみ、start-job直前にもう一度確認(race対策)してから新規RELEASE jobを開始する。`LimitExceededException`が発生した場合もfailure扱いにせず、直ちに既存jobを再検出してattachする(retry連打はしない)。
   8. `AMPLIFY_JOB_POLL` — 15秒間隔・最大30分でpolling。
   9. `AMPLIFY_STEP_VALIDATE` — BUILD/DEPLOY/VERIFYを個別に確認(overall statusだけで判断しない)。
   10. `FAILURE_DIAGNOSE`(失敗時)/`HTTP_VALIDATE`(成功時) — 失敗時はUTF-8で正しくデコードしたログ(byte配列表示バグを修正済み)から最初の実質的な失敗を自動抽出。成功時は`get-app`の`defaultDomain`から構築したURL(ハードコードしない)で`/`・`/inventory`・`/inventory/login`をHTTP確認。
   11. `BACKEND_RESOURCE_VALIDATE` — Cognito/AppSync/DynamoDB/S3の存在をread-onlyで確認(ベストエフォート)。SSR Hosting Compute Role(Backend Deployment Roleとは別物)の設定状況も確認。
   12. `COMPLETE` — 最終報告。BUILD/DEPLOY/VERIFY全てSUCCEED・HTTP確認成功まで到達しなければ「成功」とは報告しない。
   詳細は`docs/aws-test-environment.md`§9・§10・§12参照。
7. **`bello/zaico-api-token`がどのリージョンに実在するかだけを確認したい場合** → **`8-diagnose-zaico-secret.ps1`**(読み取り専用、安全) — `us-west-2`と`us-east-1`の両方で`describe-secret`を実行し、Secretの存在有無・ARN・名前だけを表示する(値は一切取得・表示しない)。`7-fix-staging-iam-role.ps1`のpreflightにも同等のチェックが組み込まれているが、ビルドを伴わずに単独で確認したい場合はこちらを使う。

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

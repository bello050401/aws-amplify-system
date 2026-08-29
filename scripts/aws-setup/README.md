# BELLO AWSテスト環境セットアップスクリプト

このディレクトリのスクリプトは、Windows PowerShell + AWS CLI から実行する前提。Claude Codeのサンドボックス環境には実AWS認証情報が無いため、これらは**ユーザーPC側で**実行する。

実行順序:

1. **`1-discover.ps1`**(読み取り専用、安全) — 現在のAWS identity・region・Amplifyアプリ/ブランチ・Secretの存在有無を確認し、次に何をすべきかを画面に表示する。何も変更しない。
2. **Amplifyアプリが既に見つかった場合** → **`3-create-branch.ps1`**(書き込みあり) — 既存のAmplifyアプリへ`claude/inventory-management-system-5vbvc7`ブランチを追加し、初回ビルドを開始する。
   **Amplifyアプリが見つからなかった場合** → **`4-create-app.ps1`**(書き込みあり) — 他の主要リージョンも再確認したうえで、GitHub Personal Access Tokenを使いAWS CLIだけでアプリ作成・ブランチ追加・初回ビルド開始までを行う(必要な本人操作はGitHub PATの発行のみ)。
3. **`2-apply-secrets-policy.ps1`**(書き込みあり) — 上記で分かった(または`4-create-app.ps1`実行後にAmplify Consoleで確認する)SSR実行ロールへ、Secrets Manager用の最小権限インラインポリシーを追加する。ロール名を引数で渡す。

## 前提

- AWS CLIがインストール済みであること(`aws --version`)。
- AWS SSOプロファイル(例: `Bello`)でログイン済みであること。未ログインの場合:
  ```powershell
  aws sso login --profile Bello
  ```
- 各スクリプトは `-ProfileName` / `-Region` 引数を受け取る(既定値: `Bello` / `us-east-1`)。

## 安全上の注意

- どのスクリプトも `main` ブランチやproductionリソースには一切触れない。
- `1-discover.ps1` はAWSリソースを一切変更しない(読み取りAPIのみ)。
- `aws sts get-caller-identity` の結果が `arn:aws:iam::<account>:root` を含む場合、`1-discover.ps1` は警告を表示して停止する — root credentialsでのIAM操作は行わないこと。IAMユーザーまたはSSO経由のロールへ切り替えてから再実行する。

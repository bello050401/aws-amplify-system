# BELLO AWSテスト環境セットアップスクリプト

このディレクトリのスクリプトは、Windows PowerShell + AWS CLI から実行する前提。Claude Codeのサンドボックス環境には実AWS認証情報が無いため、これらは**ユーザーPC側で**実行する。

実行順序:

1. **`1-discover.ps1`**(読み取り専用、安全) — 現在のAWS identity・region・Amplifyアプリ/ブランチ・Secretの存在有無を確認し、次に何をすべきかを画面に表示する。何も変更しない。
2. **`2-apply-secrets-policy.ps1`**(書き込みあり) — `1-discover.ps1`が特定したSSR実行ロールへ、Secrets Manager用の最小権限インラインポリシーを追加する。ロール名・AWSアカウントIDを引数で渡す。
3. **`3-create-branch.ps1`**(書き込みあり、Amplifyアプリが既存の場合のみ) — 既存のAmplifyアプリへ`claude/inventory-management-system-5vbvc7`ブランチを追加し、初回ビルドを開始する。**Amplifyアプリ自体がまだ存在しない場合はこのスクリプトは使えない**(AWS ConsoleでのGitHub連携が必要 — `1-discover.ps1`の出力を見て判断する)。

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

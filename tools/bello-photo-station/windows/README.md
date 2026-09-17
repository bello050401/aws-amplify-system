# BELLO Photo Station Windows

撮影PC向けの `.NET 10 / WPF / x64` 実装です。SD原本を変更せず、ローカルSSDへコピーしてSHA-256を再読込照合し、SQLite台帳へ確定します。Inventory選択や商品変更は行いません。

## 現在の実装

- removable driveまたは明示したカードrootの検出
- DCIMのARW/JPEGスナップショット
- 同一カード世代・相対path・size・mtimeによる差分判定
- 固定manifestから決定的session IDを生成し、同一取込の重複を防止
- `.partial`へのコピー、flush、再読込SHA-256照合、同一volume rename
- SQLite WAL台帳、工程状態機械、単一起動Mutex
- staging専用画面、取込履歴、SD取外し可能表示
- 別PCへ持ち込めるself-contained win-x64単一ファイルpublish
- Lightroom連携用の版付き・固定IDジョブ契約と、原子的な `.ready.json` 発行（任意コマンドとroot外pathを拒否）
- LocalSecuredになったセッションを `../src/cli.mjs` サブプロセスへ委譲する「編集してアップロード」導線
  (`PhotoUploadService` / `NodeCliPipelineRunner`。標準出力の `RESULT_JSON:` 行だけを構造化結果として読む)
- 「編集設定」画面 (`SettingsWindow`)。出力サイズ・JPEG品質・サムネイルサイズ・明るさ・コントラスト・
  色温度・彩度・シャープネス・自動回転・メタデータ削除・トリミング方法・Lightroomプリセット名を編集し、
  保存・初期設定への復元・名前付き複数プリセット・現在使用中の設定表示・テスト画像1枚での適用前後比較
  ができる。設定ファイルは `../src/settings.mjs` の `SettingsStore` と同じJSON形式 (`EditSettingsStore`)
  で、Windows/Node側のどちらで保存しても他方でそのまま読み書きできる

## 設定

端末固有値はソースへ埋め込みません。稼働PCで次を設定します。

|環境変数|用途|
|---|---|
|`BELLO_PHOTO_STATION_ROOT`|SQLite・session原本・編集設定・処理履歴の保存root。未設定時はLocalAppDataのstaging領域|
|`BELLO_PHOTO_STATION_ID`|登録済み撮影端末ID。未設定時は `UNREGISTERED-STATION`|
|`BELLO_PHOTO_CARD_ROOT`|Fixed扱いになるカードリーダーを明示する場合のdrive root|
|`BELLO_PHOTO_STATION_NODE_DIR`|`../` (tools/bello-photo-station、`src/cli.mjs`・`src/previewCli.mjs`を含む) へのパス。未設定の間は「編集してアップロード」「テスト画像プレビュー」が無効化され、SD取込・検証コピーだけが使える|
|`BELLO_PHOTO_STATION_NODE_EXE`|`node` 実行ファイル。未設定時はPATH上の `node`|
|`BELLO_PHOTO_STATION_API_ENDPOINT`|検証staging環境の画像登録API HTTPSエンドポイント(未設定の間はアップロード無効)|
|`BELLO_PHOTO_STATION_TOKEN`|Cognito等の短期認証トークン。cli.mjsの子プロセス環境変数としてのみ渡し、ログ・引数には出さない|

productionの接続情報や認証情報は含めていません。現previewはstaging専用です。

## ビルドとテスト

```powershell
dotnet test BelloPhotoStation.slnx --configuration Release
dotnet publish src/PhotoStation.Desktop/PhotoStation.Desktop.csproj --configuration Release --runtime win-x64 --self-contained true -p:PublishSingleFile=true
```

`NodeCliPipelineRunnerTests` / `NodePreviewRunnerTests` は `test/PhotoStation.Tests/fixtures/fake-cli.mjs` /
`fake-preview.mjs` (sharp等の外部依存を持たないスタブ) に対して実際に `node` サブプロセスを起動する。
テスト実行環境には `node` がPATH上にあれば十分で、`npm install` は不要。

> **未検証の注記**: この変更は `dotnet` コマンドの実行が承認ゲートで拒否される開発セッションで作成された
> ため、上記の `dotnet test` / `dotnet publish` をこの変更を書いた本人はまだ一度も実行できていない。
> マージ前に必ず `dotnet test BelloPhotoStation.slnx` を実行して確認すること。

実機Lightroom Classic連携、画像現像・加工、Credential Managerを使うCognitoログイン、署名付きinstallerは未実施です。これらは実稼働PCとAdobeログインが必要な受入れ工程として分離しています。

検証環境(`/inventory/photo-registration`)への実アップロード・ブラウザでの表示確認について: `docs/photo-registration-deployment-plan.md`
に記載の通り、画像登録用のDynamoDBテーブル・S3 prefix権限・Cognito `PHOTO_DEVICE` group・AppSyncカスタム
mutation/queryは**まだ一切デプロイ/接続されていない** (`amplify/backend.ts`・`amplify/auth/resource.ts`に
該当コードなし、grep差分ゼロを確認済み)。したがって現時点では検証staging環境自体が存在せず、
`BELLO_PHOTO_STATION_API_ENDPOINT`/`BELLO_PHOTO_STATION_TOKEN`を設定しても接続先が無い。実アップロード→
ブラウザ表示確認を行うには、先に同計画書の「3. amplify/backend.tsへ実際に接続する際の手順」を適用し、
IAM/Cognito/DynamoDBの変更を承認した上でstaging環境をデプロイする必要がある。

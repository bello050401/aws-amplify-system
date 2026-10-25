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

検証用パッケージでは `PhotoStation.Desktop.exe` を直接起動できます。必要なときはアプリ内で検証専用パスワードを入力し、認証トークンは起動中のプロセスだけに保持します。従来のPowerShell起動ファイルは不要です。AWSの `Bello` プロファイル認証は事前に有効である必要があります。
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

2026-09-23時点では、`dotnet test`で39件成功、WPFビルドとwin-x64 self-contained publishが成功しています。実機Lightroomと隔離stagingへの送信は未検証です。

Lightroom連携プラグインとXMPは配布パッケージに同梱済みです。`Install-LightroomBridge.ps1` を実行し、Lightroom Classicを再起動すると連携が自動開始します。応答が止まった場合は「ライブラリ → プラグインエクストラ → BELLO連携を開始」で再開できます。実機LightroomでのXMP現像と商品単位の構図統一は確認済み。署名付きinstallerと隔離stagingへの実送信は未検証です。

`Test-PhotoStationReadiness.ps1` はプラグイン配置、Lightroomの起動時刻、連携応答、検証API設定、端末トークンの期限を読み取り診断します。トークン本文やパスワードは表示しません。

アップロード済み画像を原本保存期限内に見直す場合は、取込履歴の対象を選び「別バッチで再編集（旧画像は保持）」を使います。元画像を照合した新しいセッションでプリセット・構図を再設定して送信します。既に商品へ紐付いた旧画像は自動差し替えしません。商品画像を置き換える工程は、参照・トップ画像・出品下書きとの整合性を検証するまで保留します。

画像登録用の独立した検証バックエンドは既存実運用stagingとは別に作成されています。専用API、Cognito、DynamoDB、S3を使い、Photo Stationの送信先はこの専用APIホストだけを許可します。既存Amplifyアプリへの統合デプロイは行っていません。現PCの検証用端末トークンは2026-09-18に期限切れのため、実送信には検証専用ユーザーの認証更新が必要です。認証情報をソースや配布物へ埋め込まないでください。

検証用ユーザーのパスワード設定後は、配布フォルダの `検証用ログインして起動.cmd` を実行する。PowerShellの非表示入力欄でパスワードを入力すると、既存の検証用Cognitoプール/クライアントだけにログインし、PHOTO_DEVICEの短期IDトークンを取得してPhoto Stationを起動する。パスワードとトークンは引数・設定ファイル・配布物へ保存しない。AWS `Bello` プロファイルの有効なログインが必要。アプリを再起動したときは再度この起動ファイルを使う。Photo Stationがすでに起動している場合は先に閉じる。

`検証用通し試験.cmd` は、非表示入力で同じ検証専用ユーザーにログインし、透かし入り合成JPEG1枚だけを隔離APIへ送る。SDカードの写真や既存取込セッションには触れない。成功receiptは `%LOCALAPPDATA%/BELLO/PhotoStation/validation-smoke/receipt.json` に秘密情報を含まず保存する。2026-09-23の実行では `PHOTO-20260923-770` がバックエンドで `READY_FOR_REVIEW`、画像1件完了・失敗0、S3の加工済み画像とサムネイル各1件を確認した。これは実API経路の検証であり、Lightroom/構図確認画面からの一括送信や業務Web画面への表示までの完了を意味しない。

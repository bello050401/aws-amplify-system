# 売上・在庫分析の検証用プレビュー

既存の在庫工程カードと、Web で使用する売上・在庫分析 UI を起動します。データは検証用の固定レコードです。仕入れ・売上・在庫の画面操作はメモリー内で処理します。

## 起動

依存関係を用意した作業ツリーで、ルートから実行します。

```powershell
$env:BELLO_PREVIEW_REVISION = (git rev-parse HEAD)
$env:BELLO_PREVIEW_DEPLOYMENT_ID = 'manual-preview'
$env:BELLO_PREVIEW_ENVIRONMENT_ID = 'local-development'
$env:BELLO_PREVIEW_DATA_SCOPE_ID = 'fixture-only'
$env:BELLO_PREVIEW_VERIFICATION_FINGERPRINT = 'manual-unverified'
node tools/inventory-analysis-preview/next-preview.mjs dev --port 4189
```

ブラウザーで `http://127.0.0.1:4189/` を開きます。`?fixture=core` では本番と共通の純粋な集計とドリルダウンを固定レコードに対して実行します。`/preview-status` はホストが渡した5項目を返します。いずれかが未設定の場合は HTTP 503 を返します。ランチャーは Windows の作業ディレクトリを実体パスに解決します。

## ブラウザーテスト

サーバー起動後、別ターミナルで実行します。

```powershell
Set-Location tools/inventory-analysis-preview
node ../../node_modules/@playwright/test/cli.js test
```

外部リクエストを遮断して、幅320・390・768・1280px、円のタップとキーボード、数量帯、明細、再読み込み、各集計単位、欠損・返品を確認します。画像は `test-results/` に保存します。`BELLO_PREVIEW_TEST_URL` と `BELLO_PREVIEW_TEST_OUTPUT` で接続先と出力先を設定できます。

Native コンポーネントを React Native Web で確認するには、別途作業ツリーの `mobile` を実体パスから開いて Expo Metro を起動します。

```powershell
Set-Location -LiteralPath (node -p 'require("fs").realpathSync("mobile")')
$env:EXPO_OFFLINE = '1'
$env:EXPO_NO_TELEMETRY = '1'
$env:CI = '1'
node node_modules/expo/bin/cli start --web --localhost --port 4190
```

Playwright ターミナルで `BELLO_NATIVE_PREVIEW_URL=http://localhost:4190/` を設定すると、テストは Expo の Web シェルへ合成データ専用の `mobile/analysis-preview.ts` を注入して実行します。StaffApp の画面遷移と戻る、集計単位の復元、既存の売却管理と帳票発行の入口を操作します。iOS と Android の実機検証は別工程です。



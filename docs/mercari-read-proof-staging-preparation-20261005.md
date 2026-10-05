# 既存商品HTTP読取証拠のstaging反映準備（2026-10-05）

対象コミットは `5e9da37` と認証状態の回帰修正 `6ba6b61`。独立レビュー完了までAWS・GitHub・PC設置版は変更しない。

## 取り込み境界

検証環境は Amplify App `d4hkkg7dty2du`、ブランチ `claude/inventory-management-system-5vbvc7`。この作業ブランチはそのリモート追跡ブランチと分岐しており、2026-10-05のローカル比較でstaging固有4コミット、候補側34コミットがある。候補ブランチ全体のmerge/push、または `5e9da37` 単体のcherry-pickはしない。stagingに無い `directReadProbe.mjs` と通信証拠の依存があり、候補側には未実証の書込観測コードも含まれる。

レビュー後、staging最新コミットから隔離ブランチを作り、両コミットのうち次のWeb側8ファイルだけを三方適用して差分を確認する。

- `app/inventory/(protected)/mercari-bridge/MercariExistingReadPanel.tsx`
- `app/inventory/(protected)/settings/MercariPcConnectionPanel.tsx`
- `lib/listing/mercariBridge/connectionStatus.ts` と `.test.mjs`
- `lib/listing/mercariBridge/resultAcceptance.ts` と `.test.mjs`
- `lib/listing/mercariBridge/resultView.ts` と `.test.mjs`

`app/api/inventory/mercari-bridge/read/route.ts`、`amplify/data/resource.ts`、`amplify.yml` はこのコミットでは変更しない。既存の結果モデルは `status` と `reasonCode` が文字列なのでスキーマ変更は不要。Web側だけを反映しても、PCの保存済み証拠が自動でBELLOへ送られることはない。

差分の作成例（PowerShell、候補ブランチで実行。`$webPaths` は上記8ファイルをそのまま列挙する）:

```powershell
$webPaths = @(
  'app/inventory/(protected)/mercari-bridge/MercariExistingReadPanel.tsx',
  'app/inventory/(protected)/settings/MercariPcConnectionPanel.tsx',
  'lib/listing/mercariBridge/connectionStatus.ts',
  'lib/listing/mercariBridge/connectionStatus.test.mjs',
  'lib/listing/mercariBridge/resultAcceptance.ts',
  'lib/listing/mercariBridge/resultAcceptance.test.mjs',
  'lib/listing/mercariBridge/resultView.ts',
  'lib/listing/mercariBridge/resultView.test.mjs'
)
$patchOne = Join-Path $env:TEMP 'bello-mercari-web-5e9da37.patch'
$patchTwo = Join-Path $env:TEMP 'bello-mercari-web-6ba6b61.patch'
git diff --binary --output=$patchOne 5e9da37^ 5e9da37 -- $webPaths
git diff --binary --output=$patchTwo 6ba6b61^ 6ba6b61 -- $webPaths
git fetch origin claude/inventory-management-system-5vbvc7
git switch -c codex/mercari-read-web-staging origin/claude/inventory-management-system-5vbvc7
git apply --3way --check $patchOne
git apply --3way $patchOne
git apply --3way --check $patchTwo
git apply --3way $patchTwo
```

競合があれば停止して当該8ファイルだけを照合する。stagingへの取り込みコミットには、上記8ファイル以外を含めない。

```powershell
git status --short
git diff --check
node --experimental-strip-types --test lib/listing/mercariBridge/resultAcceptance.test.mjs lib/listing/mercariBridge/resultView.test.mjs lib/listing/mercariBridge/connectionStatus.test.mjs
npm run typecheck
npm run build
```

## 必要な検証と反映経路

隔離ブランチでは、対象の結果受理・投影・接続状態テスト、`npm run typecheck`、`npm run build`、`git diff --check` を実施する。ビルド成功後も外部反映は別の最終判断とし、反映時はstagingブランチだけに統合してGitHubへpushする。Amplifyの当該ブランチの自動ビルドに既存jobがあれば重複して `start-job` しない。既存の `scripts/aws-setup/7-fix-staging-iam-role.ps1` はstaging専用jobを検出・監視するが、IAM修正も可能な書込スクリプトなので、この変更だけのためには実行しない。Amplifyの `amplify.yml` はバックエンドで `npm install` と `ampx pipeline-deploy`、フロントエンドで `npm install` と `npm run build` を実行する。

`MERCARI_BRIDGE_PUBLIC_ORIGIN` は `amplify.yml` がstagingのApp ID/ブランチ一致時だけ設定する既存のHTTPS Originを維持する。`NEXT_ENGINE_ISOLATED_APP=1` だと読取APIが404になるため、BELLO側には設定しない。`BASE_PRIVATE_TEST_WRITES_ENABLED`、`NEXT_ENGINE_PRIVATE_MASTER_TEST_ENABLED`、`NEXT_ENGINE_PRIVATE_MASTER_TEST_V2_ENABLED`、`NEXT_ENGINE_MASTER_UPLOAD_ENABLED`、`NEXT_ENGINE_NO_AUTO_MALL_SYNC_CONFIRMED` は既定の0を維持する。PCの `createTestObservationEnabled`、`manualObservation`、`imageWorkflowEnabled` などローカル設定も触れない。

## GPT内タブとの接続条件

PCの既存観測器は専用ChromeのPlaywright `BrowserContext` と、その同じ認証状態の `context.request` を使う。GPT内タブのログイン状態はこのPCコンテキストへ共有されず、GPT内タブの通常画面読取だけでは保存済みPC証拠のBELLO POSTを起動できない。今回の候補の報告操作はローカルPC画面から、別のBELLO用Chrome認証状態で行う設計で、Shopsへの再送はしない。GPT内タブから行うには、別途そのタブの認証を使う安全な報告経路が必要であり、現時点で未実装・未実証。

既存商品の読取成功は、新規出品・書込・公開の成功を意味しない。

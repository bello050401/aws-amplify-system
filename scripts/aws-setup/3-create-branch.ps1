<#
.SYNOPSIS
  既存のAmplifyアプリへ claude/inventory-management-system-5vbvc7
  ブランチを追加し、初回ビルド(RELEASEジョブ)を開始する(書き込みあり)。

.DESCRIPTION
  前提: 1-discover.ps1 で既存のAmplifyアプリ(bello050401/aws-amplify-system
  に接続済み)が見つかっていること。まだAmplifyアプリ自体が存在しない
  場合、このスクリプトは使えない — 先にAWS ConsoleでGitHubリポジトリを
  接続したAmplifyアプリを作成する必要がある(docs/aws-test-environment.md
  §4参照、これはGitHub OAuth同意を伴うためAWS Console操作が必須)。

  mainブランチには一切触れない。既存の他ブランチ設定も変更しない。

.PARAMETER AppId
  対象のAmplifyアプリID(1-discover.ps1の出力から取得)。必須。

.PARAMETER BranchName
  追加するブランチ名(既定: claude/inventory-management-system-5vbvc7 — 変更不要なはず)。

.PARAMETER ProfileName
  AWS CLIプロファイル名(既定: Bello)

.PARAMETER Region
  AWSリージョン(既定: us-east-1)

.PARAMETER Force
  確認プロンプトをスキップして即実行する。

.EXAMPLE
  ./3-create-branch.ps1 -AppId d1234567890abc
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,

  [string]$BranchName = "claude/inventory-management-system-5vbvc7",

  [string]$ProfileName = "Bello",
  [string]$Region = "us-east-1",

  [switch]$Force
)

$ErrorActionPreference = "Stop"

Write-Host "BELLO AWSテスト環境 — Amplifyブランチ追加" -ForegroundColor Green
Write-Host "AppId  : $AppId"
Write-Host "Branch : $BranchName (mainには一切触れません)"

if ($BranchName -eq "main") {
  Write-Host "mainブランチはこのスクリプトの対象外です。中断します。" -ForegroundColor Red
  exit 1
}

if (-not $Force) {
  $confirmation = Read-Host "アプリ '$AppId' へブランチ '$BranchName' を追加し、初回ビルドを開始しますか？ (yes と入力して続行)"
  if ($confirmation -ne "yes") {
    Write-Host "中断しました。何も変更していません。" -ForegroundColor Yellow
    exit 0
  }
}

Write-Host ""
Write-Host "-- ブランチ作成 --"
& aws amplify create-branch `
  --app-id $AppId `
  --branch-name $BranchName `
  --profile $ProfileName --region $Region

if ($LASTEXITCODE -ne 0) {
  Write-Host "ブランチ作成に失敗しました(既に存在する場合はこのエラーで問題ありません — その場合は下のジョブ開始だけ再実行してください)。" -ForegroundColor Yellow
} else {
  Write-Host "ブランチを作成しました。" -ForegroundColor Green
}

Write-Host ""
Write-Host "-- 初回ビルド(RELEASEジョブ)開始 --"
& aws amplify start-job `
  --app-id $AppId `
  --branch-name $BranchName `
  --job-type RELEASE `
  --profile $ProfileName --region $Region

if ($LASTEXITCODE -ne 0) {
  Write-Host "ジョブ開始に失敗しました。GitHub連携(webhook)が未完了の可能性があります — Amplify Consoleでブランチの状態を確認してください。" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "ビルドを開始しました。進捗確認コマンド:" -ForegroundColor Green
Write-Host "  aws amplify list-jobs --app-id $AppId --branch-name $BranchName --profile $ProfileName --region $Region"
Write-Host ""
Write-Host "ビルド完了後のURL(概ねの形。正確な値はAmplify Consoleのブランチ詳細で確認):"
$urlSafeBranch = $BranchName -replace "/", "-"
Write-Host "  https://$urlSafeBranch.$AppId.amplifyapp.com"

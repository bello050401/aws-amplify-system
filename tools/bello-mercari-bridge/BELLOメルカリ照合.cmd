@echo off
setlocal
set "BRIDGE_DIR=%~dp0"
set "BRIDGE_CONFIG=%LOCALAPPDATA%\BELLO\MercariBridge\config.json"
if not exist "%BRIDGE_CONFIG%" (
  echo BELLOメルカリ照合の設定がありません。管理者へ連絡してください。
  pause
  exit /b 1
)
node "%BRIDGE_DIR%src\desktopApp.mjs" --config "%BRIDGE_CONFIG%"
if errorlevel 1 (
  echo BELLOメルカリ照合を起動できませんでした。管理者へ連絡してください。
  pause
)

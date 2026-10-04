@echo off
setlocal
set "BRIDGE_DIR=%~dp0"
set "BRIDGE_CONFIG=%LOCALAPPDATA%\BELLO\MercariBridge\config.json"
if not exist "%BRIDGE_CONFIG%" (
  echo BELLO config is missing. Contact the administrator.
  pause
  exit /b 1
)
node "%BRIDGE_DIR%src\desktopApp.mjs" --config "%BRIDGE_CONFIG%"
if errorlevel 1 (
  echo BELLO could not start. Contact the administrator.
  pause
)

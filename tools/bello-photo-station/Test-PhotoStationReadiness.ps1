param([string]$StationRoot)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($StationRoot)) {
    $StationRoot = $env:BELLO_PHOTO_STATION_ROOT
    if ([string]::IsNullOrWhiteSpace($StationRoot)) {
        $StationRoot = Join-Path $env:LOCALAPPDATA 'BELLO/PhotoStation/staging'
    }
}
$plugin = Join-Path $env:APPDATA 'Adobe/Lightroom/Modules/BelloPhotoStation.lrplugin/Info.lua'
$heartbeat = Join-Path $StationRoot 'lightroom/heartbeat.json'
$process = Get-Process Lightroom -ErrorAction SilentlyContinue | Select-Object -First 1
$bridgeReady = $false
if (Test-Path -LiteralPath $heartbeat) {
    $bridgeReady = (Get-Item -LiteralPath $heartbeat).LastWriteTimeUtc -gt [DateTime]::UtcNow.AddSeconds(-15)
}
$tokenExpires = $null
$token = $env:BELLO_PHOTO_STATION_TOKEN
if (![string]::IsNullOrWhiteSpace($token)) {
    try {
        $parts = $token.Split('.')
        if ($parts.Length -eq 3) {
            $payload = $parts[1].Replace('-', '+').Replace('_', '/')
            $payload = $payload.PadRight($payload.Length + ((4 - $payload.Length % 4) % 4), '=')
            $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
            if ($claims.exp) { $tokenExpires = [DateTimeOffset]::FromUnixTimeSeconds([long]$claims.exp).UtcDateTime }
        }
    } catch { $tokenExpires = $null }
}
[PSCustomObject]@{
    PluginInstalled = Test-Path -LiteralPath $plugin
    LightroomRunning = $null -ne $process
    LightroomStartedBeforePlugin = $null -ne $process -and (Test-Path -LiteralPath $plugin) -and $process.StartTime.ToUniversalTime() -lt (Get-Item -LiteralPath $plugin).LastWriteTimeUtc
    BridgeResponding = $bridgeReady
    ValidationApiConfigured = ![string]::IsNullOrWhiteSpace($env:BELLO_PHOTO_STATION_API_ENDPOINT)
    TokenPresent = ![string]::IsNullOrWhiteSpace($token)
    TokenUsableByTime = $null -ne $tokenExpires -and $tokenExpires -gt [DateTime]::UtcNow.AddMinutes(2)
    TokenExpiresUtc = $tokenExpires
}

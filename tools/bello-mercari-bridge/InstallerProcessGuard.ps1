function Test-BelloMercariInstallBlocker {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$DataDir
  )
  if ($Name -in @('node.exe', 'nodew.exe')) {
    return $CommandLine -match '(?i)(?:^|[\\/\s])(?:desktopApp|cli)\.mjs(?="|\s|$)'
  }
  if ($Name -in @('chrome.exe', 'msedge.exe')) {
    foreach ($profile in @('ShopsChrome', 'BELLOChrome')) {
      $path = Join-Path $DataDir $profile
      $pattern = '(?i)--user-data-dir=(?:")?' + [regex]::Escape($path) + '(?:"|\s|$)'
      if ($CommandLine -match $pattern) { return $true }
    }
  }
  return $false
}

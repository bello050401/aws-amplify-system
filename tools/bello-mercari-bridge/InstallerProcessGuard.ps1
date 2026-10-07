function Test-BelloMercariInstallBlocker {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$DataDir
  )
  if ($Name -in @('node.exe', 'nodew.exe')) {
    return $CommandLine -match '(?i)(?:^|[\\/\s"''])(?:desktopApp|cli)\.mjs(?=$|[\s"''])'
  }
  if ($Name -in @('chrome.exe', 'msedge.exe')) {
    $normalizedLine = $CommandLine.Replace('\', '/')
    foreach ($profile in @('ShopsChrome', 'BELLOChrome')) {
      $path = (Join-Path $DataDir $profile).Replace('\', '/').TrimEnd('/')
      $pattern = '(?i)(?:^|[\s"''])--user-data-dir=(?:["''])?' +
        [regex]::Escape($path) + '/*(?=$|[\s"''])'
      if ($normalizedLine -match $pattern) { return $true }
    }
  }
  return $false
}

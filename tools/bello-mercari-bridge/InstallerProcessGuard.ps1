function Test-BelloMercariInstallBlocker {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$DataDir
  )
  if ($Name -in @('node.exe', 'nodew.exe')) {
    if ($CommandLine -match '(?i)(?:^|[\\/\s"''])desktopApp\.mjs(?=$|[\s"''])') {
      return $true
    }
    $cli = [regex]::Match($CommandLine,
      '(?i)(?:^|[\\/\s"''])cli\.mjs["'']?\s+["'']?([a-z0-9-]+)(?=$|[\s"''])')
    if (-not $cli.Success) {
      return $false
    }
    $commands = @('prepare-private-create-no-send',
      'observe-future-private-create-traffic',
      'run-b005659-private-create-ui-once',
      'run-b005413-private-create-ui-once',
      'run-visibility-transition-once', 'preflight-private-create',
      'claim-private-create-once', 'record-private-create-ui-unverified',
      'record-private-create-draft-autosave-unverified',
      'export-private-create-claim', 'export-private-create-ui-result',
      'export-saved-direct-read-proof', 'open-bello-login',
      'run-cloud-read', 'open-login', 'open-existing', 'enqueue-read',
      'run-read', 'results')
    return $commands -contains $cli.Groups[1].Value
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

param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference = 'Stop'
$src = Split-Path $PSScriptRoot
$root = Join-Path $PSScriptRoot ('.tmp-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
. (Join-Path $src 'install\common.ps1')
function Assert-True($value, $message) { if (-not $value) { throw $message } }
function Expect-Failure([scriptblock]$Action) {
  $failed = $false
  try { & $Action | Out-Null } catch { $failed = $true }
  Assert-True $failed 'Expected installer to reject unsafe or malformed configuration'
}
$configFile = Join-Path $root 'runtime.json'
[IO.File]::WriteAllText($configFile, ('{"safetyDir":' + (ConvertTo-Json -Compress (Join-Path $root 'safety')) + '}'))
$previousConfig = $env:WECHAT_MP_CONFIG
$env:WECHAT_MP_CONFIG = $configFile
try {
  $codex = Join-Path $root 'codex'
  New-Item -ItemType Directory -Path $codex | Out-Null
  $config = Join-Path $codex 'config.toml'
  $dest = Join-Path $root "plugin space's"
  $original = "model = 'fixture'`n[mcp_servers.wechat-mp]`ncommand = 'old'`n[mcp_servers.wechat-mp.env]`nA = 'old'`n[mcp_servers.wechat-mp-other]`ncommand = 'keep'`n"
  [IO.File]::WriteAllText($config, $original)
  foreach ($iteration in 1,2) { & "$src\install\install-codex.ps1" -CodexHome $codex -InstallDir $dest -NodePath $NodePath | Out-Null }
  $text = [IO.File]::ReadAllText($config)
  Assert-True (([regex]::Matches($text, '(?m)^\[mcp_servers.wechat-mp\]')).Count -eq 1) 'Duplicate Codex registration'
  Assert-True ($text.Contains("command = 'keep'") -and -not $text.Contains("A = 'old'")) 'Unrelated config lost or stale env retained'
  Assert-True ($text.Contains((ConvertTo-Json -Compress (Join-Path $dest 'bin\wechat-mp.mjs')))) 'Invalid path escaping'
  Assert-True (@(Get-ChildItem -LiteralPath $codex -Filter '*.bak-*').Count -eq 2) 'Backups were overwritten'
  # A block created by the POSIX installer must also be replaced.
  [IO.File]::WriteAllText($config, $text.Replace('install-codex.ps1','install-codex.sh'))
  & "$src\install\install-codex.ps1" -CodexHome $codex -InstallDir $dest -NodePath $NodePath | Out-Null
  [IO.File]::WriteAllText((Join-Path $dest 'user-file.txt'), 'keep')
  [IO.File]::WriteAllText((Join-Path $dest 'config.json'), '{}')
  & "$src\install\uninstall-codex.ps1" -CodexHome $codex -InstallDir $dest | Out-Null
  Assert-True ((Test-Path -LiteralPath (Join-Path $dest 'user-file.txt')) -and (Test-Path -LiteralPath (Join-Path $dest 'config.json'))) 'Uninstall deleted user files'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $dest 'bin\wechat-mp.mjs'))) 'Uninstall left plugin executable'
  $malformed = "# >>> wechat-mp-mcp (managed by install-codex.sh) >>>`n[mcp_servers.other]`ncommand='keep'"
  [IO.File]::WriteAllText($config, $malformed)
  Expect-Failure { & "$src\install\install-codex.ps1" -CodexHome $codex -InstallDir $dest -NodePath $NodePath }
  Assert-True ([IO.File]::ReadAllText($config) -eq $malformed) 'Malformed config was modified'
  Expect-Failure { & "$src\install\uninstall-codex.ps1" -CodexHome $codex -InstallDir $dest }
  Expect-Failure { Resolve-WechatNode -Hint (Join-Path $root 'missing-node.exe') }
  $dsh = Join-Path $root 'dsh'
  $profile = Join-Path $dsh 'profiles\web'
  New-Item -ItemType Directory -Path $profile -Force | Out-Null
  $patch = Join-Path $profile 'cordis.patch.yml'
  [IO.File]::WriteAllText($patch, '# single-line existing config')
  $dshDest = Join-Path $root 'dsh plugin'
  foreach ($iteration in 1,2) { & "$src\install\install-dsh.ps1" -DshHome $dsh -InstallDir $dshDest -NodePath $NodePath | Out-Null }
  $text = [IO.File]::ReadAllText($patch)
  Assert-True ($text.Contains('# single-line existing config')) 'One-line patch lost'
  Assert-True (([regex]::Matches($text, 'id: mcp-wechat-mp')).Count -eq 1) 'Duplicate DSH registration'
  [IO.File]::WriteAllText($patch, $text.Replace('install-dsh.ps1','install-dsh.sh'))
  & "$src\install\install-dsh.ps1" -DshHome $dsh -InstallDir $dshDest -NodePath $NodePath | Out-Null
  Assert-True (([regex]::Matches([IO.File]::ReadAllText($patch), 'id: mcp-wechat-mp')).Count -eq 1) 'Cross-platform upgrade duplicated DSH'
  [IO.File]::WriteAllText((Join-Path $dshDest 'user-file.txt'), 'keep')
  & "$src\install\uninstall-dsh.ps1" -DshHome $dsh -InstallDir $dshDest | Out-Null
  Assert-True (Test-Path -LiteralPath (Join-Path $dshDest 'user-file.txt')) 'DSH uninstall deleted user file'
  Assert-True ([IO.File]::ReadAllText($patch).Contains('# single-line existing config')) 'DSH uninstall lost unrelated config'
  [IO.File]::WriteAllText($patch, '[]')
  & "$src\install\install-dsh.ps1" -DshHome $dsh -InstallDir $dshDest -NodePath $NodePath | Out-Null
  Assert-True (-not ([IO.File]::ReadAllText($patch).Contains('[]'))) 'Empty YAML array was not normalized'
  [IO.File]::WriteAllText($patch, "- insert:`n    - id: mcp-wechat-mp`n      name: manual")
  $text = [IO.File]::ReadAllText($patch)
  Expect-Failure { & "$src\install\install-dsh.ps1" -DshHome $dsh -InstallDir $dshDest -NodePath $NodePath }
  Assert-True ([IO.File]::ReadAllText($patch) -eq $text) 'Manual DSH registration was altered'
  Expect-Failure { & "$src\install\install-dsh.ps1" -DshHome $dsh -ProfileName '../other' -NodePath $NodePath }
  Write-Host 'PASS: Windows install, repeat upgrade, cross-platform markers, single-line YAML, malformed markers, backups and safe uninstall.'
} finally { $env:WECHAT_MP_CONFIG = $previousConfig }

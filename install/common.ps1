$ErrorActionPreference = 'Stop'

function Resolve-WechatNode {
  param([string]$Hint)
  $candidates = @()
  if ($Hint) { $candidates = @($Hint) } else {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += @('D:\Program Files\nodejs\node.exe', "$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
  }
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $version = (& $candidate -v 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.(\d+)\.(\d+)$') {
        if ([int]$Matches[1] -gt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 19)) {
          return [pscustomobject]@{ Path = (Resolve-Path -LiteralPath $candidate).Path; Version = $version }
        }
      }
    } catch {}
  }
  throw 'Node >=22.19 required. Install Node.js or specify -NodePath with a supported executable.'
}

function Remove-WechatManagedBlock {
  param([string[]]$Lines, [ValidateSet('codex','dsh')][string]$Client)
  $kept = New-Object System.Collections.Generic.List[string]
  $inside = $false
  foreach ($line in $Lines) {
    if ($line -match "^\s*# >>> wechat-mp-mcp \(managed by install-$Client\.(ps1|sh)\) >>>\s*$") {
      if ($inside) { throw 'Nested managed configuration marker. Repair the configuration before installing.' }
      $inside = $true
      continue
    }
    if ($line -match "^\s*# <<< wechat-mp-mcp \(managed by install-$Client\.(ps1|sh)\) <<<\s*$") {
      if (-not $inside) { throw 'Unmatched managed configuration marker. Repair the configuration before installing.' }
      $inside = $false
      continue
    }
    if (-not $inside) { $kept.Add($line) }
  }
  if ($inside) { throw 'Unclosed managed configuration marker. Original configuration was not changed.' }
  return $kept.ToArray()
}

function Remove-WechatCodexSection {
  param([string[]]$Lines)
  $kept = New-Object System.Collections.Generic.List[string]
  $inside = $false
  foreach ($line in $Lines) {
    if ($line -match '^\s*\[\s*mcp_servers\s*\.\s*(?:wechat-mp|"wechat-mp"|''wechat-mp'')\s*(?:\]|\.)') { $inside = $true; continue }
    if ($line -match '^\s*\[') { $inside = $false }
    if (-not $inside) { $kept.Add($line) }
  }
  return $kept.ToArray()
}

function Backup-WechatConfig {
  param([string]$Path)
  $backup = "$Path.bak-$(Get-Date -Format yyyyMMdd-HHmmss-fffffff)"
  Copy-Item -LiteralPath $Path -Destination $backup
  return $backup
}

# Remove only files shipped by this plugin. Never recursively delete a user-supplied directory.
function Remove-WechatFiles {
  param([string]$Directory)
  $root = [IO.Path]::GetFullPath($Directory)
  foreach ($relative in @('bin\wechat-mp.mjs','bin\wechat-mp-cli.mjs','README.md','SKILL.md','config.example.json','LICENSE')) {
    $file = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $file.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation path.' }
    if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
  }
  foreach ($directoryPath in @((Join-Path $root 'bin'), $root)) {
    if ((Test-Path -LiteralPath $directoryPath -PathType Container) -and @(Get-ChildItem -LiteralPath $directoryPath -Force).Count -eq 0) {
      Remove-Item -LiteralPath $directoryPath
    }
  }
}

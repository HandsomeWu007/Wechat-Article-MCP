<#
.SYNOPSIS
  从 DeepSeek Harness (dsh) 卸载 wechat-mp MCP 服务。

.DESCRIPTION
  移除 cordis.patch.yml 中的 wechat-mp 条目（自动备份），并删除安装目录与 Skill。

  注意：-KeepFiles 会同时保留安装目录和 Skill；不带该参数则两者都删。
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$ProfileName = 'web',
  [string]$InstallDir = '',
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'
$Patch  = Join-Path $DshHome "profiles\$ProfileName\cordis.patch.yml"
$InstallDir   = if ($InstallDir) { $InstallDir } else { Join-Path $DshHome 'wechat-mp-mcp' }
$markerBegin = '# >>> wechat-mp-mcp (managed by install-dsh.ps1) >>>'
$markerEnd   = '# <<< wechat-mp-mcp (managed by install-dsh.ps1) <<<'

if (Test-Path $Patch) {
  $lines = Get-Content -Path $Patch -Encoding UTF8
  $b = -1; $e = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -like "*$markerBegin*") { $b = $i }
    if ($lines[$i] -like "*$markerEnd*")   { $e = $i }
  }
  if ($b -ge 0 -and $e -ge $b) {
    $bak = "$Patch.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $Patch $bak -Force
    $kept = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($i -ge $b -and $i -le $e) { continue }
      $kept += $lines[$i]
    }
    Set-Content -Path $Patch -Value ($kept -join "`n") -Encoding UTF8
    Write-Host "已移除 cordis.patch.yml 中的 wechat-mp 条目（备份: $bak）" -ForegroundColor Green
  } else {
    Write-Host 'cordis.patch.yml 中没有 wechat-mp 条目，跳过。' -ForegroundColor Yellow
  }
} else {
  Write-Host "未找到 $Patch，跳过。" -ForegroundColor Yellow
}

if (-not $KeepFiles) {
  foreach ($p in @($InstallDir, (Join-Path $DshHome 'skills\wechat-mp'))) {
    if (Test-Path $p) {
      Remove-Item $p -Recurse -Force
      Write-Host "已删除 $p" -ForegroundColor Green
    }
  }
} else {
  Write-Host "-KeepFiles：保留 $InstallDir" -ForegroundColor DarkGray
}

Write-Host '完成，重启 DeepSeek Harness 生效。' -ForegroundColor Green

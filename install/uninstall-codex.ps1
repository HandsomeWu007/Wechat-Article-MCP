<#
.SYNOPSIS
  从 Codex CLI 卸载 wechat-mp MCP 服务。

.DESCRIPTION
  1. 从 ~/.codex/config.toml 移除 wechat-mp 段（含本脚本的托管段和手写段，自动备份）
  2. 删除安装目录（除非指定 -KeepFiles）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File uninstall-codex.ps1
  powershell -ExecutionPolicy Bypass -File uninstall-codex.ps1 -InstallDir "C:\Users\you\tools\wechat-mp-mcp" -KeepFiles
#>
[CmdletBinding()]
param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
  [string]$InstallDir = '',
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'

$InstallDir = if ($InstallDir) { $InstallDir } else { Join-Path $env:USERPROFILE 'tools\wechat-mp-mcp' }
$Config = Join-Path $CodexHome 'config.toml'

# ---------- 清理配置 ----------
if (Test-Path $Config) {
  $lines = Get-Content -Path $Config -Encoding UTF8
  $markerBegin = '# >>> wechat-mp-mcp (managed by install-codex'
  $markerEnd   = '# <<< wechat-mp-mcp (managed by install-codex'

  $kept = New-Object System.Collections.Generic.List[string]
  $mode = ''
  $removed = $false
  foreach ($line in $lines) {
    if ($line -like "*$markerBegin*") { $mode = 'marker'; $removed = $true; continue }
    if ($mode -eq 'marker') {
      if ($line -like "*$markerEnd*") { $mode = '' }
      continue
    }
    if ($mode -eq '') {
      if ($line -match '^\s*\[mcp_servers\.wechat-mp(?:\]|\.)') { $mode = 'section'; $removed = $true; continue }
    } else {
      if ($line -match '^\s*\[mcp_servers\.wechat-mp(?:\]|\.)') { continue }; if ($line -match '^\s*\[') { $mode = '' } else { continue }
    }
    $kept.Add($line)
  }

  if ($removed) {
    $bak = "$Config.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $Config $bak -Force
    [IO.File]::WriteAllText($Config, (($kept -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
    Write-Host "[1/2] 已移除 config.toml 中的 wechat-mp 段（备份: $bak）" -ForegroundColor Green
  } else {
    Write-Host '[1/2] config.toml 中没有 wechat-mp 段' -ForegroundColor DarkGray
  }
} else {
  Write-Host "[1/2] 未找到 $Config" -ForegroundColor DarkGray
}

# ---------- 删除文件 ----------
if ($KeepFiles) {
  Write-Host "[2/2] 保留文件: $InstallDir" -ForegroundColor DarkGray
} elseif (Test-Path $InstallDir) {
  Remove-Item $InstallDir -Recurse -Force
  Write-Host "[2/2] 已删除 $InstallDir" -ForegroundColor Green
} else {
  Write-Host "[2/2] 安装目录不存在: $InstallDir" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '卸载完成。重开 Codex 会话后 mcp__wechat-mp__* 工具将不再出现。' -ForegroundColor Green

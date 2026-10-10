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
. (Join-Path $PSScriptRoot "common.ps1")
$Patch  = Join-Path $DshHome "profiles\$ProfileName\cordis.patch.yml"
$InstallDir   = if ($InstallDir) { $InstallDir } else { Join-Path $DshHome 'wechat-mp-mcp' }
$markerBegin = '# >>> wechat-mp-mcp (managed by install-dsh.ps1) >>>'
$markerEnd   = '# <<< wechat-mp-mcp (managed by install-dsh.ps1) <<<'

if ($ProfileName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid profile name.' }
if (Test-Path -LiteralPath $Patch) {
  $lines = @(Get-Content -LiteralPath $Patch -Encoding UTF8)
  $kept = @(Remove-WechatManagedBlock -Lines $lines -Client dsh)
  if (($lines -join "`n") -ne ($kept -join "`n")) {
    $bak = Backup-WechatConfig -Path $Patch
    [IO.File]::WriteAllText($Patch, (($kept -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Removed managed configuration (backup: $bak)"
  }
}

if (-not $KeepFiles) {
  Remove-WechatFiles -Directory $InstallDir
  $skillDir = Join-Path $DshHome 'skills\wechat-mp'
  $skill = Join-Path $skillDir 'SKILL.md'
  $originalSkill = Join-Path (Join-Path $PSScriptRoot '..') 'SKILL.md'
  if ((Test-Path -LiteralPath $skill -PathType Leaf) -and (Test-Path -LiteralPath $originalSkill -PathType Leaf)) {
    if ((Get-FileHash -LiteralPath $skill).Hash -eq (Get-FileHash -LiteralPath $originalSkill).Hash) {
      Remove-Item -LiteralPath $skill
      if (@(Get-ChildItem -LiteralPath $skillDir -Force).Count -eq 0) { Remove-Item -LiteralPath $skillDir }
    }
  }
} else {
  Write-Host "-KeepFiles：保留 $InstallDir" -ForegroundColor DarkGray
}

Write-Host '完成，重启 DeepSeek Harness 生效。' -ForegroundColor Green

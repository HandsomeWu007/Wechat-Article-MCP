<#
.SYNOPSIS
  把 wechat-mp MCP 服务装进 Codex CLI。

.DESCRIPTION
  1. 把单文件 MCP server 复制到安装目录（默认 $env:USERPROFILE\tools\wechat-mp-mcp；
     可用 -InstallDir 改到别处）
  2. 在 ~/.codex/config.toml 里写入 [mcp_servers.wechat-mp] 段
     （已存在托管段则先移除再写入，可重复执行；每次自动备份）
  3. 用 CLI status 做一次自检

  装完重开一个 Codex 会话（或 TUI 里 /mcp）即可看到 mcp__wechat-mp__* 工具。
  等价的命令行写法：codex mcp add wechat-mp -- <node> <server>

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-codex.ps1
  powershell -ExecutionPolicy Bypass -File install-codex.ps1 -InstallDir "C:\Users\you\tools\wechat-mp-mcp"
#>
[CmdletBinding()]
param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
  [string]$NodePath = '',
  [string]$InstallDir = '',
  [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'

# ---------- 路径 ----------
$Src    = Resolve-Path (Join-Path $PSScriptRoot '..')
$SrcBin = Join-Path $Src 'bin'
$InstallDir = if ($InstallDir) { $InstallDir } else { Join-Path $env:USERPROFILE 'tools\wechat-mp-mcp' }
$Config = Join-Path $CodexHome 'config.toml'

if (-not (Test-Path (Join-Path $SrcBin 'wechat-mp.mjs'))) {
  throw "找不到 $SrcBin\wechat-mp.mjs，请在解压后的根目录执行本脚本。"
}

# ---------- 选择 node ----------
. (Join-Path $PSScriptRoot "common.ps1")

$nodeInfo = Resolve-WechatNode -Hint $NodePath
$node     = $nodeInfo.Path
$nodeVer  = $nodeInfo.Version
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

Write-Host "[1/4] node: $node ($nodeVer)" -ForegroundColor Cyan

if (Test-Path -LiteralPath $Config) {
  $null = @(Remove-WechatManagedBlock -Lines @(Get-Content -LiteralPath $Config -Encoding UTF8) -Client codex)
}

# ---------- 复制文件 ----------
Write-Host "[2/4] 安装服务到 $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'bin') | Out-Null
Copy-Item (Join-Path $SrcBin 'wechat-mp.mjs')      (Join-Path $InstallDir 'bin\wechat-mp.mjs')     -Force
Copy-Item (Join-Path $SrcBin 'wechat-mp-cli.mjs')  (Join-Path $InstallDir 'bin\wechat-mp-cli.mjs') -Force
foreach ($f in @('README.md', 'SKILL.md', 'config.example.json', 'LICENSE')) {
  $p = Join-Path $Src $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $InstallDir $f) -Force }
}
$serverEntry = Join-Path $InstallDir 'bin\wechat-mp.mjs'
$cliEntry    = Join-Path $InstallDir 'bin\wechat-mp-cli.mjs'

# ---------- 写 config.toml ----------
Write-Host "[3/4] 写入 $Config" -ForegroundColor Cyan
$markerBegin = '# >>> wechat-mp-mcp (managed by install-codex.ps1) >>>'
$markerEnd   = '# <<< wechat-mp-mcp (managed by install-codex.ps1) <<<'

# 使用 JSON 字符串转义生成 TOML basic string
$nodeEsc   = ConvertTo-Json -Compress $node
$serverEsc = ConvertTo-Json -Compress $serverEntry

$block = @"

$markerBegin
[mcp_servers.wechat-mp]
command = $nodeEsc
args = [$serverEsc]
startup_timeout_sec = 20
tool_timeout_sec = 300
# 需要更快/更稳时，把浏览器里的 cookie 填进来后取消注释：
# [mcp_servers.wechat-mp.env]
# WECHAT_MP_SOGOU_COOKIE = 'SNUID=xxxx; SUID=xxxx'
$markerEnd
"@

if (-not (Test-Path $Config)) {
  New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
  [IO.File]::WriteAllText($Config, $block, (New-Object Text.UTF8Encoding($false)))
  Write-Host "      已创建新配置: $Config" -ForegroundColor Yellow
} else {
  $lines = @(Get-Content -LiteralPath $Config -Encoding UTF8)
  $kept = @(Remove-WechatManagedBlock -Lines $lines -Client codex)
  $kept = @(Remove-WechatCodexSection -Lines $kept)
  if (-not $NoBackup) {
    $bak = Backup-WechatConfig -Path $Config
    Write-Host "      原配置已备份: $bak" -ForegroundColor DarkGray
  }
  $text = ($kept -join "`n")
  if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
  [IO.File]::WriteAllText($Config, ($text + $block + "`n"), (New-Object Text.UTF8Encoding($false)))
}

# ---------- 自检 ----------
Write-Host '[4/4] 自检' -ForegroundColor Cyan
try {
  $out = & $node $cliEntry status 2>&1 | Out-String
  if ($out -match '"ok"\s*:\s*true') {
    Write-Host '      MCP server 可正常启动 OK' -ForegroundColor Green
  } else {
    Write-Host "      status 返回异常：`n$out" -ForegroundColor Yellow
  }
} catch {
  Write-Host "      自检失败: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Write-Host '安装完成。重开一个 Codex 会话（或 TUI 里 /mcp）即可加载。' -ForegroundColor Green
Write-Host '可用的 7 个工具：wechat_search_articles / search_accounts / fetch_article /' -ForegroundColor Green
Write-Host 'fetch_batch / resolve_url / list_account_articles / status' -ForegroundColor Green
Write-Host ''
Write-Host "手动验证: & '$node' '$cliEntry' search `"量子计算`" --count 3" -ForegroundColor DarkGray
Write-Host "等价命令: codex mcp add wechat-mp -- '$node' '$serverEntry'" -ForegroundColor DarkGray

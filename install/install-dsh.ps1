<#
.SYNOPSIS
  把 wechat-mp MCP 服务装进 DeepSeek Harness (dsh)。

.DESCRIPTION
  1. 把单文件 MCP server 复制到安装目录（默认 $env:USERPROFILE\.dsh\wechat-mp-mcp\bin\；
     可用 -InstallDir 改到别处，例如 C:\Users\you\tools\wechat-mp-mcp，让 dsh 与 Codex 共用一份）
  2. 在 dsh 的 cordis.patch.yml 里插入一条 @deepseek-ai/dsh-mcp-client 实例
     （已存在同名条目则先移除再写入，可重复执行）
  3. 可选：把 SKILL.md 装到 ~/.dsh/skills/wechat-mp/
  4. 用 CLI status 做一次自检

  装完重启 dsh（或在插件页刷新），模型即可使用 mcp__wechat-mp__* 工具。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-dsh.ps1
  powershell -ExecutionPolicy Bypass -File install-dsh.ps1 -DshHome "$env:USERPROFILE\.dsh" -ProfileName web
  powershell -ExecutionPolicy Bypass -File install-dsh.ps1 -InstallDir "C:\Users\you\tools\wechat-mp-mcp"
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$ProfileName = 'web',
  [string]$NodePath = '',
  [string]$InstallDir = '',
  [switch]$NoSkill
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot "common.ps1")

# ---------- 路径 ----------
$Src    = Resolve-Path (Join-Path $PSScriptRoot '..')
$SrcBin = Join-Path $Src 'bin'
$InstallDir   = if ($InstallDir) { $InstallDir } else { Join-Path $DshHome 'wechat-mp-mcp' }
$Patch  = Join-Path $DshHome "profiles\$ProfileName\cordis.patch.yml"

if (-not (Test-Path (Join-Path $SrcBin 'wechat-mp.mjs'))) {
  throw "找不到 $SrcBin\wechat-mp.mjs，请在解压后的根目录执行本脚本。"
}
if (-not (Test-Path $DshHome)) {
  throw "dsh 目录不存在：$DshHome（可用 -DshHome 指定，或设置环境变量 DSH_HOME）"
}

if ($ProfileName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid profile name.' }
if (Test-Path -LiteralPath $Patch) {
  $existingLines = @(Get-Content -LiteralPath $Patch -Encoding UTF8)
  $existingLines = @(Remove-WechatManagedBlock -Lines $existingLines -Client dsh)
  $contentLines = @($existingLines | Where-Object { $_.Trim() -and $_ -notmatch '^\s*#' })
  if ($contentLines.Count -eq 1 -and $contentLines[0] -match '^\s*\[\s*\]\s*(?:#.*)?$') {
    $existingLines = @($existingLines | Where-Object { $_ -ne $contentLines[0] })
  } elseif ($contentLines.Count -gt 0 -and $contentLines[0] -notmatch '^\s*-\s') {
    throw 'Expected a YAML block sequence or an empty array. Original configuration was not changed.'
  }
  if (($existingLines -join "`n") -match '(?m)^\s*-?\s*id\s*:\s*["'']?mcp-wechat-mp["'']?\s*(?:#.*)?$') {
    throw 'Existing unmanaged mcp-wechat-mp registration found. Remove it before running this installer.'
  }
}

# ---------- 选择 node ----------
$nodeInfo = Resolve-WechatNode -Hint $NodePath
$node = $nodeInfo.Path
$nodeVer = $nodeInfo.Version
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

Write-Host "[1/5] node: $node ($nodeVer)" -ForegroundColor Cyan

# ---------- 复制文件 ----------
Write-Host "[2/5] 安装服务到 $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'bin') | Out-Null
Copy-Item (Join-Path $SrcBin 'wechat-mp.mjs')      (Join-Path $InstallDir 'bin\wechat-mp.mjs')      -Force
Copy-Item (Join-Path $SrcBin 'wechat-mp-cli.mjs') (Join-Path $InstallDir 'bin\wechat-mp-cli.mjs')  -Force
foreach ($f in @('README.md', 'SKILL.md', 'config.example.json', 'LICENSE')) {
  $p = Join-Path $Src $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $InstallDir $f) -Force }
}
$serverEntry = Join-Path $InstallDir 'bin\wechat-mp.mjs'
$cliEntry    = Join-Path $InstallDir 'bin\wechat-mp-cli.mjs'

# ---------- 写 cordis.patch.yml ----------
Write-Host "[3/5] 写入 cordis.patch.yml: $Patch" -ForegroundColor Cyan
$markerBegin = '# >>> wechat-mp-mcp (managed by install-dsh.ps1) >>>'
$markerEnd   = '# <<< wechat-mp-mcp (managed by install-dsh.ps1) <<<'

$nodeYaml = $node.Replace("'", "''")
$serverYaml = $serverEntry.Replace("'", "''")
$dirYaml = $InstallDir.Replace("'", "''")
$block = @"
$markerBegin
- insert:
    - id: mcp-wechat-mp
      # 官方 MCP 客户端桥接插件：一个实例 = 一台 MCP server
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: wechat-mp
        transport: stdio
        command: '$nodeYaml'
        args: ['$serverYaml']
        cwd: '$dirYaml'
        # 抓正文会串行请求多个页面，默认 60s 不够
        toolCallTimeoutMs: 300000
        failOnStartupError: false
        # 需要更快/更稳时，把浏览器里的 cookie 填进来后取消注释：
        # env:
        #   WECHAT_MP_SOGOU_COOKIE: 'SNUID=xxxx; SUID=xxxx'
$markerEnd
"@

if (-not (Test-Path $Patch)) {
  $header = @(
    '# 由 wechat-mp-mcp 安装脚本创建',
    '# 这是一个 YAML 数组，每一项是 loader patch 条目。'
  ) -join "`n"
  New-Item -ItemType Directory -Force -Path (Split-Path $Patch) | Out-Null
  [IO.File]::WriteAllText($Patch, ($header + "`n" + $block + "`n"), (New-Object Text.UTF8Encoding($false)))
} else {
  $lines = $existingLines
  $bak = Backup-WechatConfig -Path $Patch
  $text = ($lines -join "`n")
  if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
  [IO.File]::WriteAllText($Patch, ($text + $block + "`n"), (New-Object Text.UTF8Encoding($false)))
  Write-Host "      原配置已备份: $bak" -ForegroundColor DarkGray
}

# ---------- 可选：安装 Skill ----------
if (-not $NoSkill) {
  $skillDir = Join-Path $DshHome 'skills\wechat-mp'
  $skillSrc = Join-Path $Src 'SKILL.md'
  if (Test-Path $skillSrc) {
    New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
    Copy-Item $skillSrc (Join-Path $skillDir 'SKILL.md') -Force
    Write-Host "[4/5] Skill 已安装到 $skillDir" -ForegroundColor Cyan
  } else {
    Write-Host '[4/5] 跳过 Skill（未找到 SKILL.md）' -ForegroundColor DarkGray
  }
} else {
  Write-Host '[4/5] 跳过 Skill（-NoSkill）' -ForegroundColor DarkGray
}

# ---------- 自检 ----------
Write-Host '[5/5] 自检' -ForegroundColor Cyan
try {
  $out = & $node $cliEntry status 2>&1 | Out-String
  if ($out -match '"ok"\s*:\s*true') {
    Write-Host '      MCP server 可正常启动 ✅' -ForegroundColor Green
  } else {
    Write-Host "      status 返回异常：`n$out" -ForegroundColor Yellow
  }
} catch {
  Write-Host "      自检失败: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Write-Host '安装完成。请完全退出并重启 DeepSeek Harness。' -ForegroundColor Green
Write-Host '之后模型可用的工具（7 个）：' -ForegroundColor Green
Write-Host '  mcp__wechat-mp__wechat_search_articles      按关键词搜索公众号文章'
Write-Host '  mcp__wechat-mp__wechat_search_accounts      搜索公众号'
Write-Host '  mcp__wechat-mp__wechat_fetch_article        读取文章正文（Markdown）'
Write-Host '  mcp__wechat-mp__wechat_fetch_batch          批量读取'
Write-Host '  mcp__wechat-mp__wechat_resolve_url          解析搜狗跳转链接'
Write-Host '  mcp__wechat-mp__wechat_list_account_articles 公众号文章列表'
Write-Host '  mcp__wechat-mp__wechat_status               查看运行状态'
Write-Host ''
Write-Host "手动验证: & '$node' '$cliEntry' search `"量子计算`" --count 3" -ForegroundColor DarkGray

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

# ---------- 选择 node ----------
function Resolve-Node {
  param([string]$Hint)
  $candidates = @()
  if ($Hint) { $candidates += $Hint }
  $candidates += @(
    'D:\Program Files\nodejs\node.exe',
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }

  foreach ($c in $candidates) {
    if (-not $c) { continue }
    if (Test-Path $c) {
      try {
        $v = (& $c -v 2>$null | Out-String).Trim()
        if ($v -match 'v(\d+)') {
          $major = [int]$Matches[1]
          if ($major -ge 22) {
            # 返回对象，不要返回数组：PowerShell 多值返回容易被粘成一个字符串
            return [pscustomobject]@{ Path = $c; Version = $v }
          }
        }
      } catch {}
    }
  }
  throw '未找到 Node >= 22.19。请先安装 Node.js，或用 -NodePath 指定 node.exe 的完整路径。'
}

$nodeInfo = Resolve-Node -Hint $NodePath
$node = $nodeInfo.Path
$nodeVer = $nodeInfo.Version
& $node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19))process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw '需要 Node >=22.19；推荐 Node 24 LTS。' }
Write-Host "[1/5] node: $node ($nodeVer)" -ForegroundColor Cyan

# ---------- 复制文件 ----------
Write-Host "[2/5] 安装服务到 $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'bin') | Out-Null
Copy-Item (Join-Path $SrcBin 'wechat-mp.mjs')      (Join-Path $InstallDir 'bin\wechat-mp.mjs')      -Force
Copy-Item (Join-Path $SrcBin 'wechat-mp-cli.mjs') (Join-Path $InstallDir 'bin\wechat-mp-cli.mjs')  -Force
foreach ($f in @('README.md', 'SKILL.md', 'config.example.json')) {
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
  Set-Content -Path $Patch -Value ($header + "`n" + $block) -Encoding UTF8
} else {
  $lines = Get-Content -Path $Patch -Encoding UTF8
  $b = -1; $e = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -like "*$markerBegin*") { $b = $i }
    if ($lines[$i] -like "*$markerEnd*")   { $e = $i }
  }
  if ($b -ge 0 -and $e -ge $b) {
    $kept = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($i -ge $b -and $i -le $e) { continue }
      $kept += $lines[$i]
    }
    $lines = $kept
    Write-Host '      已移除旧的 wechat-mp 条目（升级安装）' -ForegroundColor Yellow
  }
  $bak = "$Patch.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $Patch $bak -Force
  $text = ($lines -join "`n")
  if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
  Set-Content -Path $Patch -Value ($text + $block + "`n") -Encoding UTF8
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

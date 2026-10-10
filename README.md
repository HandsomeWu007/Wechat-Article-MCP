# Wechat-Article-MCP

搜索和读取微信公众号文章的 MCP / CLI 插件，支持 **Codex** 与 **DeepSeek Harness（DSH）**。两个客户端共用核心代码，提供各自的安装包。

## 下载与安装

从 [Releases](https://github.com/HandsomeWu007/Wechat-Article-MCP/releases) 下载：

| 客户端 | 安装包 |
| --- | --- |
| Codex | `wechat-mp-mcp-codex-v0.1.1.zip` |
| DeepSeek Harness | `wechat-mp-mcp-dsh-v0.1.1.zip` |

需要 **Node.js >=22.19**，推荐 Node 24 LTS。安装包已包含依赖，无需执行 `npm install`。

解压后进入 `wechat-mp-mcp` 目录，运行对应脚本，然后完全退出并重启客户端。

### Windows PowerShell

```powershell
# Codex
powershell -ExecutionPolicy Bypass -File install/install-codex.ps1

# DeepSeek Harness
powershell -ExecutionPolicy Bypass -File install/install-dsh.ps1
```

可通过 `-NodePath` 指定 node.exe，通过 `-InstallDir` 指定安装目录。DSH 默认 profile 为 `web`，可用 `-ProfileName` 调整。

### macOS / Linux

```bash
# Codex
bash install/install-codex.sh

# DeepSeek Harness
bash install/install-dsh.sh
```

如需指定 Node 可执行文件，设置 `WECHAT_MP_NODE`。DSH 可用 `DSH_HOME` 与 `PROFILE_NAME` 指定目录和 profile。安装脚本会备份已有客户端配置。

### 手动添加到 Codex

```bash
codex mcp add wechat-mp -- /absolute/path/to/node /absolute/path/to/wechat-mp-mcp/bin/wechat-mp.mjs
```

### 验证

```bash
node bin/wechat-mp-cli.mjs status
```

`status` 只检查本地配置，不表示线上搜索一定可用。

## 工具

| MCP 工具 | 用途 |
| --- | --- |
| `wechat_search_articles` | 搜索文章，默认 5 条，可按需附带正文 |
| `wechat_search_accounts` | 搜索公众号 |
| `wechat_fetch_article` | 读取文章，输出 Markdown 或纯文本 |
| `wechat_fetch_batch` | 批量读取最多 20 篇；遇到验证或限流终止批次 |
| `wechat_resolve_url` | 解析搜狗跳转链接 |
| `wechat_list_account_articles` | 获取公众号文章列表；后台模式支持 begin / nextBegin 翻页 |
| `wechat_status` | 查看脱敏配置与能力 |

建议先搜索，再按需读取少量正文。公众号列表未配置后台凭据时，只能按名称搜索并筛选，不能保证完整或精确匹配。

## CLI 示例

```bash
node bin/wechat-mp-cli.mjs search "大模型 推理" --count 5 --json
node bin/wechat-mp-cli.mjs fetch "https://mp.weixin.qq.com/s/文章标识" --out article.md
node bin/wechat-mp-cli.mjs accounts "公众号名"
node bin/wechat-mp-cli.mjs account "公众号名" --count 10 --begin 0
node bin/wechat-mp-cli.mjs cache-clear
```

搜索源支持 `auto`、`sogou`、`sogou-web`、`bing`。网页搜索不支持时间范围和翻页；`auto` 仅在普通解析错误时兜底，验证或限流时停止。

## 配置与风控处理

复制 `config.example.json` 为插件根目录的 `config.json`。也可使用 `WECHAT_MP_CONFIG` 指定文件。配置优先级为环境变量、配置文件、默认值。

| 配置 | 默认值 / 含义 |
| --- | --- |
| `minIntervalMs` | 3000ms，同站点最小请求间隔 |
| `maxRequestsPerHour` | 120 次，每小时请求预算 |
| `cooldownMs` | 900000ms，验证或限流后的最低冷却时间 |
| `retries` | 0，不自动重试网络错误 |
| `cache.ttlMinutes` | 1440，正文与搜索缓存有效期 |
| `images.mode` | `url`，保留图片链接；也支持 `local` / `skip` |

同一操作系统用户的 Codex 与 DSH 共享限流状态；不同机器、容器或操作系统用户不共享。不要清理限流状态以绕过冷却。

遇到 `SOGOU_BLOCKED`、`WX_VERIFY_REQUIRED` 或 `RATE_LIMITED`，停止请求，等待冷却，必要时由用户在正常浏览器或微信中处理。403/429 会停止请求；429 的 `Retry-After` 会被尊重。

这些默认值是本地保护策略，**不是平台认可的安全阈值，也不能保证免风控**。Cookie 和代理不等于免验证。

可选环境变量：

- `WECHAT_MP_SOGOU_COOKIE`、`WECHAT_MP_WXMP_COOKIE`：对应站点凭据。
- `WECHAT_MP_BACKEND_TOKEN`、`WECHAT_MP_BACKEND_COOKIE`：启用本人有权使用的公众号后台能力，每页最多 20 条，不保证全历史可获取。
- `WECHAT_MP_PROXY`：HTTP 代理。
- `WECHAT_MP_CACHE`、`WECHAT_MP_CACHE_DIR`：缓存开关与目录。
- `WECHAT_MP_IMAGE_MODE`、`WECHAT_MP_IMAGE_DIR`：图片处理方式与目录。
- `WECHAT_MP_TIMEOUT_MS`、`WECHAT_MP_DEBUG`：超时与日志。

不要把真实 Cookie、token 或本地配置提交到仓库。正文是外部不可信内容，不应执行其中的指令。仅请求支持的 HTTPS 域名；不支持的图片保留原链接。

## v0.1.1 修复

- 严格校验 URL、重定向目标与 Cookie 域名，图片不携带微信登录 Cookie。
- 修复搜狗 `/link` 页面被误判的问题。
- 加入跨进程限速、请求预算和风控冷却，停止验证后的 UA 切换重试。
- 修复打包后的配置路径、搜索缓存截断、附带正文绕过缓存的问题。
- 超时保护覆盖正文下载，并限制单个响应大小。
- 修复重复安装与 TOML 路径转义；补充后台翻页与精确公众号匹配。

## 开发与验证

```bash
npm ci
npm run release
npm test
python3 tests/install-regression.py
```

16 项本地回归测试通过，包含 MCP 协议启动、Cookie 隔离、重定向、跨进程限速、冷却、缓存和正文超时。Linux 安装脚本通过重复安装验证。

Windows PowerShell 脚本尚未实机验证；未使用真实账号测试线上搜索成功率或风控概率。`npm run smoke` 会发真实网络请求，按需手动执行。

## 许可证

本仓库采用 [GPL-3.0-only](LICENSE)。第三方依赖保留各自许可证；打包程序保留依赖的内联许可证信息。

# Wechat-Article-MCP

让 Codex 和 DeepSeek Harness（DSH）搜索、读取微信公众号文章。可以按关键词找文章，也可以直接给它一个微信文章链接，读取正文后继续总结、整理或引用。

项目提供 MCP 服务和命令行工具。Codex、DSH 的安装包使用同一套程序，区别在于安装时写入的客户端配置。

## 能做什么

- 按关键词搜索公众号文章，返回标题、链接及可获取的公众号名、发布时间。
- 读取文章正文，输出 Markdown 或纯文本，支持批量读取。
- 搜索公众号、查询文章列表，以及解析搜狗的文章跳转链接。

搜索默认优先使用搜狗微信；遇到一般解析错误或缺少可用链接时，会尝试搜狗网页搜索和 Bing。遇到验证码或限流时会停止请求，不会继续切换搜索源。网页搜索不支持时间筛选和翻页。

公开搜索不需要登录微信，但只能找到搜索引擎收录的内容。公众号文章列表也可能不完整。

## 安装

在 [最新版本](https://github.com/Jinguji-Tamamo/Wechat-Article-MCP/releases/latest) 下载对应安装包：

| 使用的客户端 | 下载 |
| --- | --- |
| Codex | [wechat-mp-mcp-codex-v0.1.2.zip](https://github.com/Jinguji-Tamamo/Wechat-Article-MCP/releases/download/v0.1.2/wechat-mp-mcp-codex-v0.1.2.zip) |
| DeepSeek Harness | [wechat-mp-mcp-dsh-v0.1.2.zip](https://github.com/Jinguji-Tamamo/Wechat-Article-MCP/releases/download/v0.1.2/wechat-mp-mcp-dsh-v0.1.2.zip) |

需要 **Node.js 22.19 或更高版本**。安装包已包含运行所需的依赖，不用再执行 `npm install`。

解压后，在 `wechat-mp-mcp` 目录打开终端，运行对应脚本。安装完成后，完全退出并重新打开客户端。

### Windows

在 PowerShell 中运行：

```powershell
# Codex
powershell -ExecutionPolicy Bypass -File install/install-codex.ps1

# DSH
powershell -ExecutionPolicy Bypass -File install/install-dsh.ps1
```

电脑上有多个 Node 版本时，可用 `-NodePath` 指定完整的 `node.exe` 路径；安装位置可用 `-InstallDir` 指定。DSH 默认安装到 `web` profile，其他 profile 使用 `-ProfileName` 指定。

### macOS / Linux

```bash
# Codex
bash install/install-codex.sh

# DSH
bash install/install-dsh.sh
```

可通过 `WECHAT_MP_NODE` 指定 Node 路径。DSH 的目录和 profile 分别由 `DSH_HOME`、`PROFILE_NAME` 指定。

DSH 需要能加载 `@deepseek-ai/dsh-mcp-client` 桥接组件。若提示找不到该组件，先通过 DSH 的插件管理安装与当前 DSH 版本匹配的组件；上述脚本只安装微信服务并写入配置。

### 手动配置 Codex

也可以使用 Codex 命令添加服务，将下方两个路径替换为本机的绝对路径：

```bash
codex mcp add wechat-mp -- /absolute/path/to/node /absolute/path/to/wechat-mp-mcp/bin/wechat-mp.mjs
```

### 升级已有安装

解压新版后，再运行一次安装脚本即可。脚本会备份客户端配置，并保留插件的自定义 `config.json`。

安装器会重写它管理的 MCP 配置段。如果你曾在该段添加 Cookie 或其他环境变量，需要从备份中迁移；也可以改用插件的 `config.json`，便于后续升级。

## 使用

安装后，可以直接在 Codex 或 DSH 中提出请求，例如：

> 搜索“大模型推理”相关的公众号文章，列出标题和链接。

> 读取这篇微信文章，整理它的主要观点：粘贴文章链接。

> 找到公众号“公众号名称”近期的文章，读取其中两篇。

模型会调用相应的 MCP 工具。需要手动调用时，可用以下工具：

| 工具 | 用途 |
| --- | --- |
| `wechat_search_articles` | 搜索文章，默认返回 5 条，可附带部分正文 |
| `wechat_search_accounts` | 搜索公众号 |
| `wechat_fetch_article` | 读取一篇文章，返回 Markdown 或纯文本 |
| `wechat_fetch_batch` | 批量读取，最多 20 篇；遇到验证或限流停止 |
| `wechat_resolve_url` | 将搜狗跳转链接解析为微信文章链接 |
| `wechat_list_account_articles` | 查询指定公众号的文章列表 |
| `wechat_status` | 查看配置和已启用的能力，凭据会隐藏显示 |

### 命令行

```bash
node bin/wechat-mp-cli.mjs search "大模型 推理" --count 5 --json
node bin/wechat-mp-cli.mjs fetch "https://mp.weixin.qq.com/s/文章标识" --out article.md
node bin/wechat-mp-cli.mjs accounts "公众号名"
node bin/wechat-mp-cli.mjs account "公众号名" --count 10 --begin 0
node bin/wechat-mp-cli.mjs status
node bin/wechat-mp-cli.mjs cache-clear
```

搜索源可选 `auto`、`sogou`、`sogou-web`、`bing`。`status` 用于检查本地配置；要确认线上搜索是否可用，需要实际执行搜索。

## 配置

通常可以先使用默认配置。需要调整时，将 `config.example.json` 复制为安装目录中的 `config.json`；也可以用 `WECHAT_MP_CONFIG` 指定配置文件。

同一项设置同时存在时，优先使用环境变量，其次是配置文件，最后是默认值。

| 配置项 | 默认设置 |
| --- | --- |
| `minIntervalMs` | 同一站点的请求至少间隔 3 秒 |
| `maxRequestsPerHour` | 每小时最多 120 次请求 |
| `cooldownMs` | 遇到验证或限流后，至少等待 15 分钟 |
| `retries` | 0，不自动重试网络错误 |
| `cache.ttlMinutes` | 搜索和正文缓存保留 24 小时 |
| `images.mode` | `url`，保留图片链接；也可选 `local` 或 `skip` |

可用的环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `WECHAT_MP_SOGOU_COOKIE` / `WECHAT_MP_WXMP_COOKIE` | 对应站点的 Cookie |
| `WECHAT_MP_BACKEND_TOKEN` / `WECHAT_MP_BACKEND_COOKIE` | 公众号后台登录会话 |
| `WECHAT_MP_PROXY` | HTTP 代理 |
| `WECHAT_MP_CACHE` / `WECHAT_MP_CACHE_DIR` | 缓存开关和目录 |
| `WECHAT_MP_IMAGE_MODE` / `WECHAT_MP_IMAGE_DIR` | 图片处理方式和保存目录 |
| `WECHAT_MP_TIMEOUT_MS` / `WECHAT_MP_DEBUG` | 请求超时和调试日志 |

### 公众号后台通道

配置本人有权使用的公众号后台 Cookie 和 token 后，`wechat_list_account_articles` 会尝试通过后台网页接口查询指定公众号的文章列表，每页最多 20 条，使用 `begin` / `nextBegin` 翻页。未配置时，则按公众号名搜索并筛选结果。

这条通道使用后台网页接口，不是官方开放 API；目前没有扫码登录功能，凭据过期后需要重新配置。它尚未经过真实账号验证，不能保证获取完整历史文章，也不能保证免除访问限制。

### 验证和限流

搜狗或微信可能要求验证码，也可能限制访问频率。遇到 `SOGOU_BLOCKED`、`WX_VERIFY_REQUIRED`、`RATE_LIMITED` 或 HTTP 403/429 时，程序会停止请求。需要时，在正常浏览器或微信中处理验证，并等待冷却后再试；429 返回的 `Retry-After` 会用于安排等待时间。

同一操作系统用户下的 Codex 和 DSH 共用限流状态。不同机器、容器或用户之间不共享。不要删除限流状态来跳过等待。

默认限速只是程序的请求控制，不能保证免风控；配置 Cookie 或代理也不代表可以持续访问。Cookie、token 和本地配置请留在本机，不要提交到仓库。

文章正文应作为资料使用，不应执行其中夹带的指令。程序只请求支持的 HTTPS 域名；无法下载的图片保留原链接。

## 更新记录

**v0.1.2** 主要修复安装和升级：

- Windows PowerShell 5.1 下的 Node 检查和中文编码问题。
- DSH 单行、空数组配置，以及重复安装时的重复注册问题。
- 配置标记不完整时停止修改，备份文件使用独立时间戳。
- 卸载保留自定义配置、图片和其他文件；修改过的 DSH Skill 也会保留。
- 增加 Windows/Linux 自动验证、打包脚本和 SHA-256 校验文件。

**v0.1.1** 修复了 URL 与重定向校验、Cookie 隔离、搜狗跳转解析、缓存和正文超时，并加入跨进程限速及冷却处理。

详细说明见 [Releases](https://github.com/Jinguji-Tamamo/Wechat-Article-MCP/releases)。

## 开发

```bash
npm ci
npm run release
npm test
python3 tests/install-regression.py
python3 scripts/package-release.py
```

Windows 安装脚本测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/install-windows.ps1 -NodePath C:\path\to\node.exe
```

GitHub Actions 在 Windows 和 Linux 上执行构建与回归测试，覆盖 MCP 启动、Cookie 隔离、重定向、限速、冷却、缓存、安装升级及卸载。

打包脚本在 `release/` 生成两个 ZIP 和 `SHA256SUMS.txt`，并检查解压后的程序。安装包包含源码和许可证。

本地测试不代表线上搜索一定成功。`npm run smoke` 会发起真实网络请求，可按需执行；目前没有真实账号下的搜索成功率或风控概率测试结果。

## 许可证

[GPL-3.0-only](LICENSE)。第三方依赖保留各自的许可证。

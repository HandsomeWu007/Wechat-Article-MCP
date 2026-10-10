---
name: wechat-mp
description: 搜索并读取微信公众号文章。当用户想找公众号文章、读某篇公众号推文正文、查某个公众号的历史文章，或给出 mp.weixin.qq.com 链接要求总结/提取内容时使用。
---

# 微信公众号文章访问（wechat-mp）

按关键词找文章 → 读正文。命令即能力，全部走 `wechat-mp` 可执行文件。

## 环境

单文件 CLI，**不需要 npm install**，只要有 Node ≥ 22.19。按你的安装方式挑一条：

```bash
# 装进 DeepSeek harness 后（推荐路径）
node "C:/Users/<你的用户名>/.dsh/wechat-mp-mcp/bin/wechat-mp-cli.mjs" <子命令>

# 解压即用
node "<解压目录>/wechat-mp-mcp/bin/wechat-mp-cli.mjs" <子命令>

# 用源码构建的版本
node "<项目目录>/dist/cli.js" <子命令>
```

下面示例统一用 `CLI` 指代上面这条命令。

## 用法

```bash
CLI search "关键词" --count 5 --json          # 搜索（--json 便于解析，结果里取 url）
CLI fetch "<文章URL>" --out article.md        # 读正文（Markdown，可落盘）
CLI fetch "<URL>" --format text               # 只要纯文本
CLI batch "<url1>" "<url2>" --json            # 批量，最多 20 条
CLI accounts "公众号名"                        # 搜公众号
CLI account "公众号名" --count 10              # 列该号文章
CLI resolve "<搜狗 /link 链接>"                # 解析成真实链接
CLI status                                    # 排障时先看这个
CLI cache-clear                               # 清缓存
```

## 工作流

1. 用户给了关键词 → `search --json`，从 `hits[].url` 取链接（跳过 `url` 为空的条目）。
2. 用户直接给了 `mp.weixin.qq.com` 链接 → 直接 `fetch`，不用先搜。
3. 长文优先 `--out` 落盘再分段读，避免一次塞进上下文；正文默认截断 60000 字符。

## 注意

- 遇到 `SOGOU_BLOCKED`、`WX_VERIFY_REQUIRED`、`RATE_LIMITED`，停止本次任务并告知用户。不要立即重试、换代理、换账号或索取 Cookie 来绕过验证。等待冷却，必要时由用户在正常浏览器中处理。
- auto 仅对普通解析错误提供网页搜索兜底；验证码、403、429、环境异常会立即停止。网页搜索不支持时间范围和翻页。
- 结果里带 `notice` 字段时先读它，里面说明了降级原因。
- 同一篇文章 24 小时内有缓存；要最新就加 `--no-cache`。

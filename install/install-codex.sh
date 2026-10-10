#!/usr/bin/env bash
# 把 wechat-mp MCP 服务装进 Codex CLI（macOS / Linux）
#
#   bash install/install-codex.sh
#   INSTALL_DIR="$HOME/tools/wechat-mp-mcp" bash install/install-codex.sh
#
# 装完重开一个 Codex 会话（或 TUI 里 /mcp）即可加载。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_BIN="$SRC/bin"
INSTALL_DIR="${INSTALL_DIR:-$HOME/tools/wechat-mp-mcp}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_HOME/config.toml"

[ -f "$SRC_BIN/wechat-mp.mjs" ] || { echo "找不到 $SRC_BIN/wechat-mp.mjs，请在解压后的根目录执行本脚本。" >&2; exit 1; }

# ---------- 选择 node ----------
NODE="${WECHAT_MP_NODE:-}"
if [ -z "$NODE" ]; then
  for c in "$(command -v node || true)" /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    major=$("$c" -v | sed 's/^v//' | cut -d. -f1)
    if [ "${major:-0}" -ge 18 ] 2>/dev/null; then NODE="$c"; break; fi
  done
fi
[ -n "$NODE" ] || { echo "未找到 Node >= 22.19，请用 WECHAT_MP_NODE=/path/to/node 指定。" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<19)) {console.error("Node >=22.19 required");process.exit(1)}'
echo "[1/4] node: $NODE ($("$NODE" -v))"

# ---------- 复制文件 ----------
echo "[2/4] 安装服务到 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/bin"
cp "$SRC_BIN/wechat-mp.mjs"      "$INSTALL_DIR/bin/wechat-mp.mjs"
cp "$SRC_BIN/wechat-mp-cli.mjs"  "$INSTALL_DIR/bin/wechat-mp-cli.mjs"
for f in README.md SKILL.md config.example.json; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$INSTALL_DIR/$f"
done
SERVER="$INSTALL_DIR/bin/wechat-mp.mjs"
CLI="$INSTALL_DIR/bin/wechat-mp-cli.mjs"

# ---------- 写 config.toml ----------
echo "[3/4] 写入 $CONFIG"
MARK_BEGIN='# >>> wechat-mp-mcp (managed by install-codex.sh) >>>'
MARK_END='# <<< wechat-mp-mcp (managed by install-codex.sh) <<<'

BLOCK="
$MARK_BEGIN
[mcp_servers.wechat-mp]
command = $("$NODE" -p 'JSON.stringify(process.argv[1])' "$NODE")
args = [$("$NODE" -p 'JSON.stringify(process.argv[1])' "$SERVER")]
startup_timeout_sec = 20
tool_timeout_sec = 300
# [mcp_servers.wechat-mp.env]
# WECHAT_MP_SOGOU_COOKIE = 'SNUID=xxxx; SUID=xxxx'
$MARK_END
"

mkdir -p "$CODEX_HOME"
if [ ! -f "$CONFIG" ]; then
  printf '%s\n' "$BLOCK" > "$CONFIG"
  echo "      已创建新配置: $CONFIG"
else
  cp "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
  if grep -q 'managed by install-codex' "$CONFIG"; then
    echo "      已移除旧的 wechat-mp 段（升级安装）"
  fi
  # 删掉旧的托管段（含标记行）
  # 状态机一次性清掉两种旧写法：带标记行的托管段 + 手工写入的 [mcp_servers.wechat-mp]。
  # 不清干净会留下重复定义，TOML 直接解析失败。
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    index($0,b)                                             { mode="marker"; next }
    mode=="marker" { if (index($0,e)) mode=""; next }
    mode=="" && $0 ~ /^[[:space:]]*\[mcp_servers\.wechat-mp(\]|\.)/ { mode="section"; next }
    mode=="section" && $0 ~ /^[[:space:]]*\[mcp_servers\.wechat-mp(\]|\.)/ { next }
    mode=="section" {
      if ($0 ~ /^[[:space:]]*\[/) { mode="" } else { next }
    }
    { print }
  ' "$CONFIG" > "$CONFIG.tmp"
  mv "$CONFIG.tmp" "$CONFIG"
  printf '%s\n' "$BLOCK" >> "$CONFIG"
fi

# ---------- 自检 ----------
echo "[4/4] 自检"
if "$NODE" "$CLI" status 2>&1 | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "      MCP server 可正常启动 OK"
else
  echo "      status 返回异常（见上方输出）"
fi

echo
echo "安装完成。重开一个 Codex 会话（或 TUI 里 /mcp）即可加载。"
echo "手动验证: $NODE $CLI search \"量子计算\" --count 3"
echo "等价命令: codex mcp add wechat-mp -- $NODE $SERVER"

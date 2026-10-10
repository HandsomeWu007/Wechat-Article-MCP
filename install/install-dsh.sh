#!/usr/bin/env bash
# 把 wechat-mp MCP 服务装进 DeepSeek Harness (dsh) —— macOS / Linux
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${PROFILE_NAME:-web}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${INSTALL_DIR:-$DSH_HOME/wechat-mp-mcp}"
[[ "$PROFILE_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo 'Invalid profile name' >&2; exit 1; }
PATCH="$DSH_HOME/profiles/$PROFILE_NAME/cordis.patch.yml"

if [[ ! -f "$SRC/bin/wechat-mp.mjs" ]]; then
  echo "找不到 $SRC/bin/wechat-mp.mjs，请在解压后的根目录执行本脚本。" >&2
  exit 1
fi
if [[ ! -d "$DSH_HOME" ]]; then
  echo "dsh 目录不存在：$DSH_HOME（可用 DSH_HOME 环境变量指定）" >&2
  exit 1
fi

# Select only a supported runtime. An explicit override must not silently fall back.
NODE=""
if [[ -n "${WECHAT_MP_NODE:-}" ]]; then
  CANDIDATES=("$WECHAT_MP_NODE")
else
  CANDIDATES=("$(command -v node || true)" /usr/local/bin/node /opt/homebrew/bin/node)
fi
for c in "${CANDIDATES[@]}"; do
  [[ -n "$c" && -x "$c" ]] || continue
  if "$c" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then
    NODE="$(cd "$(dirname "$c")" && pwd)/$(basename "$c")"
    break
  fi
done
[[ -n "$NODE" ]] || { echo 'Node >=22.19 required. Set WECHAT_MP_NODE to a supported executable.' >&2; exit 1; }
echo "node: $NODE ($("$NODE" -v))"

CLEANED=""
if [[ -f "$PATCH" ]]; then CLEANED=$("$NODE" "$SRC/install/clean-config.mjs" dsh "$PATCH"); fi
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

# ---- 复制 ----
echo "[2/5] 安装服务到 $DEST"
mkdir -p "$DEST/bin"
cp "$SRC/bin/wechat-mp.mjs" "$DEST/bin/wechat-mp.mjs"
cp "$SRC/bin/wechat-mp-cli.mjs" "$DEST/bin/wechat-mp-cli.mjs"
for f in README.md SKILL.md config.example.json LICENSE; do
  [[ -f "$SRC/$f" ]] && cp "$SRC/$f" "$DEST/$f"
done

# ---- patch ----
echo "[3/5] 写入 cordis.patch.yml: $PATCH"
BEGIN='# >>> wechat-mp-mcp (managed by install-dsh.sh) >>>'
END='# <<< wechat-mp-mcp (managed by install-dsh.sh) <<<'
NODE_YAML=$("$NODE" -p 'process.argv[1].replaceAll(String.fromCharCode(39), String.fromCharCode(39,39))' "$NODE")
DEST_YAML=$("$NODE" -p 'process.argv[1].replaceAll(String.fromCharCode(39), String.fromCharCode(39,39))' "$DEST")
BLOCK="$BEGIN
- insert:
    - id: mcp-wechat-mp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: wechat-mp
        transport: stdio
        command: '$NODE_YAML'
        args: ['$DEST_YAML/bin/wechat-mp.mjs']
        cwd: '$DEST_YAML'
        toolCallTimeoutMs: 300000
        failOnStartupError: false
$END"

mkdir -p "$(dirname "$PATCH")"
if [[ -f "$PATCH" ]]; then
  cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)-$$-$RANDOM"
  printf '%s\n%s\n' "$CLEANED" "$BLOCK" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
else
  printf '%s\n' "$BLOCK" > "$PATCH"
fi

# ---- skill ----
echo "[4/5] 安装 Skill"
if [[ -f "$SRC/SKILL.md" ]]; then
  mkdir -p "$DSH_HOME/skills/wechat-mp"
  cp "$SRC/SKILL.md" "$DSH_HOME/skills/wechat-mp/SKILL.md"
fi

# ---- 自检 ----
echo "[5/5] 自检"
if "$NODE" "$DEST/bin/wechat-mp-cli.mjs" status 2>&1 | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo '      MCP server 可正常启动'
else
  echo '      status 异常，请手动检查'
fi

cat <<TIP

安装完成。请完全退出并重启 DeepSeek Harness。
工具：mcp__wechat-mp__wechat_search_articles / wechat_fetch_article / ... 共 7 个
手动验证: "$NODE" "$DEST/bin/wechat-mp-cli.mjs" search "量子计算" --count 3
TIP

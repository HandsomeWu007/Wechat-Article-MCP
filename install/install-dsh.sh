#!/usr/bin/env bash
# 把 wechat-mp MCP 服务装进 DeepSeek Harness (dsh) —— macOS / Linux
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${PROFILE_NAME:-web}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$DSH_HOME/wechat-mp-mcp"
PATCH="$DSH_HOME/profiles/$PROFILE_NAME/cordis.patch.yml"

if [[ ! -f "$SRC/bin/wechat-mp.mjs" ]]; then
  echo "找不到 $SRC/bin/wechat-mp.mjs，请在解压后的根目录执行本脚本。" >&2
  exit 1
fi
if [[ ! -d "$DSH_HOME" ]]; then
  echo "dsh 目录不存在：$DSH_HOME（可用 DSH_HOME 环境变量指定）" >&2
  exit 1
fi

# ---- node ----
NODE=""
for c in "${WECHAT_MP_NODE:-}" "$(command -v node || true)" /usr/local/bin/node /opt/homebrew/bin/node; do
  [[ -z "$c" || ! -x "$c" ]] && continue
  if [[ "$("$c" -v 2>/dev/null || true)" =~ ^v([0-9]+) ]] && (( BASH_REMATCH[1] >= 22 )); then
    NODE="$c"; break
  fi
done
[[ -z "$NODE" ]] && { echo "未找到 Node >= 22.19，请先安装 Node.js。" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<19)) {console.error("Node >=22.19 required");process.exit(1)}'
echo "[1/5] node: $NODE ($("$NODE" -v))"

# ---- 复制 ----
echo "[2/5] 安装服务到 $DEST"
mkdir -p "$DEST/bin"
cp "$SRC/bin/wechat-mp.mjs" "$DEST/bin/wechat-mp.mjs"
cp "$SRC/bin/wechat-mp-cli.mjs" "$DEST/bin/wechat-mp-cli.mjs"
for f in README.md SKILL.md config.example.json; do
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
  if grep -qF "$BEGIN" "$PATCH"; then
    cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
    awk -v b="$BEGIN" -v e="$END" '
      index($0,b) {skip=1}
      skip {if (index($0,e)) skip=0; next}
      {print}
    ' "$PATCH" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
    echo "      已移除旧的 wechat-mp 条目（升级安装）"
  else
    cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  printf '%s\n%s\n' "$(cat "$PATCH")" "$BLOCK" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
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
if "$NODE" "$DEST/bin/wechat-mp-cli.mjs" status 2>&1 | grep -q '"ok"'; then
  echo '      MCP server 可正常启动'
else
  echo '      status 异常，请手动检查'
fi

cat <<TIP

安装完成。请完全退出并重启 DeepSeek Harness。
工具：mcp__wechat-mp__wechat_search_articles / wechat_fetch_article / ... 共 7 个
手动验证: "$NODE" "$DEST/bin/wechat-mp-cli.mjs" search "量子计算" --count 3
TIP

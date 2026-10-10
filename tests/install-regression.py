from pathlib import Path
import tempfile,subprocess,os,tomllib
src=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
 root=Path(tmp).resolve();codex=root/'codex';codex.mkdir();dest=root/'plugin';config=codex/'config.toml'
 config.write_text('[mcp_servers.wechat-mp]\ncommand="old"\n[mcp_servers.wechat-mp.env]\nA="old"\n[mcp_servers.wechat-mp-other]\ncommand="keep"\n')
 if (src/'install/install-codex.sh').exists():
  script=(src/'install/install-codex.sh').read_text().replace('SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',f'SRC="{src}"').replace('CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"',f'CODEX_CONFIG_DIR="{codex}"').replace('$CODEX_HOME','$CODEX_CONFIG_DIR')
  env={**os.environ,'INSTALL_DIR':str(dest)}
  for _ in range(2):subprocess.run(['bash','-c',script],env=env,check=True,text=True)
  c=tomllib.loads(config.read_text());assert c['mcp_servers']['wechat-mp-other']['command']=='keep';assert 'env' not in c['mcp_servers']['wechat-mp'];assert c['mcp_servers']['wechat-mp']['args']==[str(dest/'bin/wechat-mp.mjs')]
  print('Codex install twice: PASS; unrelated config retained, stale env removed')
 if not (src/'install/install-dsh.sh').exists(): raise SystemExit(0)
 dsh=root/'dsh';dsh.mkdir();env={**os.environ,'DSH_HOME':str(dsh)}
 for _ in range(2):subprocess.run(['bash',str(src/'install/install-dsh.sh')],env=env,check=True,text=True)
 patch=(dsh/'profiles/web/cordis.patch.yml').read_text();assert patch.count('id: mcp-wechat-mp')==1
 print('DSH install twice: PASS; one plugin registration')

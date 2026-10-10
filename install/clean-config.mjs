import fs from 'node:fs';

// Shared by the POSIX installers; recognize blocks created on either platform.
const [client, file] = process.argv.slice(2);
if (!['codex', 'dsh'].includes(client) || !file) throw new Error('Expected client and config path');
const begin = new RegExp(`^\\s*# >>> wechat-mp-mcp \\(managed by install-${client}\\.(?:sh|ps1)\\) >>>\\s*$`);
const end = new RegExp(`^\\s*# <<< wechat-mp-mcp \\(managed by install-${client}\\.(?:sh|ps1)\\) <<<\\s*$`);
let inside = false;
const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const kept = [];
for (const line of lines) {
  if (begin.test(line)) {
    if (inside) throw new Error('Nested managed configuration marker');
    inside = true;
  } else if (end.test(line)) {
    if (!inside) throw new Error('Unmatched managed configuration marker');
    inside = false;
  } else if (!inside) kept.push(line);
}
if (inside) throw new Error('Unclosed managed configuration marker; original configuration was not changed');
const result = [];
inside = false;
for (const line of kept) {
  if (client === 'codex') {
    if (/^\s*\[\s*mcp_servers\s*\.\s*(?:wechat-mp|"wechat-mp"|'wechat-mp')\s*(?:\]|\.)/.test(line)) { inside = true; continue; }
    if (/^\s*\[/.test(line)) inside = false;
  }
  if (!inside) result.push(line);
}
let text = result.join('\n');
if (client === 'dsh') {
  const content = result.filter(line => line.trim() && !/^\s*#/.test(line));
  if (content.length === 1 && /^\s*\[\s*\]\s*(?:#.*)?$/.test(content[0])) {
    text = result.filter(line => line !== content[0]).join('\n');
  } else if (content.length && !/^\s*-\s/.test(content[0])) {
    throw new Error('Expected a YAML block sequence or an empty array; original configuration was not changed');
  }
}
if (client === 'dsh' && /^\s*-?\s*id\s*:\s*["']?mcp-wechat-mp["']?\s*(?:#.*)?$/m.test(text)) {
  throw new Error('Existing unmanaged mcp-wechat-mp registration found; remove it before installing');
}
process.stdout.write(text);

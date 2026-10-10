/**
 * 校验 dsh 的 cordis.patch.yml：YAML 是否合法、wechat-mp 实例配置是否正确、
 * command / args / cwd 指向的文件是否真实存在。
 *
 *   node scripts/check-patch.cjs [patch文件路径]
 *
 * YAML 解析器直接借用 dsh 自带的那份（自动找最新版本的 node_modules），
 * 与 dsh 实际使用的库保持一致；找不到就跳过解析，只做文本层面的检查。
 */
const fs = require('node:fs');
const path = require('node:path');

const DSH_DATA =
  process.env.DSH_DATA_DIR ||
  path.join(process.env.APPDATA || '', 'DSH', 'data', 'versions');

/** 找到 dsh 最新版本的 node_modules（用于取 yaml / js-yaml） */
function findDshModules() {
  if (!fs.existsSync(DSH_DATA)) return null;
  const versions = fs
    .readdirSync(DSH_DATA)
    .filter((v) => fs.existsSync(path.join(DSH_DATA, v, 'node_modules')))
    .sort();
  if (!versions.length) return null;
  return path.join(DSH_DATA, versions[versions.length - 1], 'node_modules');
}

function tryParse(label, fn) {
  try {
    return { ok: true, doc: fn() };
  } catch (e) {
    console.log(`[${label}] 解析失败: ${e.message.split('\n')[0]}`);
    return { ok: false };
  }
}

const file =
  process.argv[2] ||
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'web', 'cordis.patch.yml');

if (!fs.existsSync(file)) {
  console.log(`文件不存在: ${file}`);
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');
console.log(`文件: ${file}`);
console.log(`大小: ${src.length} 字节`);

const nm = findDshModules();
let doc = null;
if (nm) {
  const mod = path.join(nm, 'yaml');
  if (fs.existsSync(mod)) {
    const YAML = require(mod);
    const r = tryParse('yaml', () => YAML.parse(src));
    if (r.ok) {
      doc = r.doc;
      console.log(`[yaml] OK 顶层条目数: ${Array.isArray(doc) ? doc.length : typeof doc}`);
    }
  } else {
    console.log('[yaml] 跳过：dsh 目录里没找到 yaml 包');
  }
} else {
  console.log('[yaml] 跳过：未找到 dsh 版本目录，无法借用解析器');
}

if (!doc) {
  const mm = nm && path.join(nm, 'js-yaml');
  if (mm && fs.existsSync(mm)) {
    const jsyaml = require(mm);
    const r = tryParse('js-yaml', () => jsyaml.load(src));
    if (r.ok) doc = r.doc;
  }
}

// 文本层面：无论能否解析，都确认标记块存在且不重复
const marks = src.split('\n').filter((l) => l.includes('wechat-mp-mcp (managed')).length;
console.log(`wechat-mp 管理标记行数: ${marks}（应为 2：开始 + 结束）`);

if (Array.isArray(doc)) {
  const entries = doc.filter((e) => e && e.insert);
  const mine = entries
    .flatMap((e) => e.insert)
    .filter((i) => i && String(i.id).includes('wechat-mp'));
  if (!mine.length) {
    console.log('未找到 wechat-mp 实例条目。');
    process.exit(1);
  }
  for (const inst of mine) {
    const c = inst.config || {};
    console.log('--- wechat-mp 实例 ---');
    console.log(JSON.stringify(inst, null, 2));
    const checks = [
      ['name 是官方 MCP 桥接插件', inst.name === '@deepseek-ai/dsh-mcp-client'],
      ['transport = stdio', c.transport === 'stdio'],
      ['serverName 符合 [A-Za-z0-9_-]{1,32}', /^[A-Za-z0-9_-]{1,32}$/.test(String(c.serverName || ''))],
      ['command 文件存在', !!c.command && fs.existsSync(c.command)],
      ['args[0] 文件存在', !!c.args?.[0] && fs.existsSync(c.args[0])],
      ['cwd 目录存在', !!c.cwd && fs.existsSync(c.cwd)],
    ];
    console.log('--- 校验 ---');
    let bad = 0;
    for (const [k, ok] of checks) {
      if (!ok) bad++;
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${k}`);
    }
    process.exit(bad ? 1 : 0);
  }
} else {
  console.log('提示：无法解析 YAML，请人工确认格式。');
}

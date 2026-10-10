/**
 * 把 MCP server 与 CLI 打成单文件 ESM（.mjs），无需 node_modules 即可运行。
 *
 * 为什么需要 banner：部分依赖（iconv-lite / safer-buffer）是 CJS 且内部有
 * `require('buffer')`，esbuild 在 ESM 输出下会把它们转成动态 require 并在运行时抛
 * "Dynamic require of X is not supported"。用 createRequire 兜住即可。
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 直接输出到项目根的 bin/，让仓库/解压目录本身就能直接运行（与 zip 结构一致）
const outDir = path.join(root, 'bin');
fs.mkdirSync(outDir, { recursive: true });

const banner =
  `import { createRequire as __wxCreateRequire } from 'node:module';\n` +
  `const require = __wxCreateRequire(import.meta.url);\n`;

/**
 * 说明：不要把 undici 设为 external。esbuild 会把外部模块的动态 import()
 * 提升成顶层 `import * as undici from "undici"`，一旦目标机器没装 undici，
 * 单文件会在加载阶段直接 ERR_MODULE_NOT_FOUND（而不是等到真用代理时才报错）。
 * 打进来后体积增加约 0.6MB，换来"解压即用"的确定性，值得。
 */
const external = [];

const targets = [
  { entry: 'src/index.ts', out: 'wechat-mp.mjs', label: 'MCP server' },
  { entry: 'src/cli.ts', out: 'wechat-mp-cli.mjs', label: 'CLI' },
];

for (const t of targets) {
  const result = await esbuild.build({
    entryPoints: [path.join(root, t.entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(outDir, t.out),
    external: ['node:*', ...external],
    banner: { js: banner },
    logLevel: 'warning',
  });
  const size = fs.statSync(path.join(outDir, t.out)).size;
  console.log(`${t.label.padEnd(10)} -> bin/${t.out}  ${(size / 1024 / 1024).toFixed(2)} MB`);
  if (result.warnings?.length) {
    for (const w of result.warnings) console.log('  warn:', w.text);
  }
}

console.log('单文件打包完成（运行只需 Node >= 22.19，无需 npm install）');

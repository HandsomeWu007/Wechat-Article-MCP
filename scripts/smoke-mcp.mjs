import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
/** 默认测 dist/，设 WECHAT_MP_ENTRY=single 可测 bin/ 下的单文件产物 */
const entry =
  process.env.WECHAT_MP_ENTRY === 'single'
    ? path.join(root, 'bin', 'wechat-mp.mjs')
    : process.env.WECHAT_MP_ENTRY || path.join(root, 'dist', 'index.js');

const transport = new StdioClientTransport({
  command: node,
  args: [entry],
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const status = await client.callTool({ name: 'wechat_status', arguments: {} });
console.log('status ->', String(status.content[0].text).slice(0, 300));

const search = await client.callTool({
  name: 'wechat_search_articles',
  arguments: { query: 'DeepSeek 论文', count: 2, engine: 'sogou-web' },
});
const text = String(search.content[0].text);
const parsed = JSON.parse(text);
console.log('search engine:', parsed.engine, 'hits:', parsed.hits.map((h) => h.title.slice(0, 24)));

const first = parsed.hits.find((h) => h.url);
if (first) {
  const art = await client.callTool({ name: 'wechat_fetch_article', arguments: { url: first.url, maxChars: 1500 } });
  const data = JSON.parse(String(art.content[0].text));
  console.log('fetch ->', data.title, '| 字数', data.wordCount, '| 正文前 80 字:', data.content.slice(0, 80).replace(/\n/g, ' '));
} else {
  console.log('fetch -> 无可用的文章链接');
}

await client.close();

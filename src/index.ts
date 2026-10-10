import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WechatMpService } from './core/service.js';
import { WechatError } from './core/errors.js';

const service = new WechatMpService();

function ok(payload: unknown, maxChars?: number) {
  let text = JSON.stringify(payload, null, 2);
  let truncated = false;
  if (maxChars && text.length > maxChars) {
    text = JSON.stringify({ truncated: true, notice: '结果超过 maxChars，请缩小 count 或增大 maxChars', preview: text.slice(0, Math.max(0, maxChars - 200)) });
    truncated = true;
  }
  return { content: [{ type: 'text' as const, text }], structuredNote: truncated };
}

function fail(err: unknown) {
  const payload =
    err instanceof WechatError
      ? err.toJSON()
      : { error: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

async function run<T>(fn: () => Promise<T>): Promise<any> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

const server = new McpServer(
  {
    name: 'wechat-mp',
    version: '0.1.2',
  },
  {
    instructions:
      '用于搜索和读取微信公众号文章的插件。典型流程：先用 wechat_search_articles 按关键词找到文章，拿到 url 后用 wechat_fetch_article 读取正文（Markdown）。' +
      '也可以直接把用户粘贴的 mp.weixin.qq.com 链接交给 wechat_fetch_article。注意抓取受平台频控影响，失败时稍后重试或降低并发。',
    capabilities: { tools: {}, logging: {} },
  },
);

server.tool(
  'wechat_search_articles',
  '按关键词搜索微信公众号文章（走搜狗微信）。返回标题、公众号、时间、摘要与真实文章链接；' +
    '需要正文时设 withContent>0 直接抓取前 N 篇，或把 url 交给 wechat_fetch_article。',
  {
    query: z.string().min(1).describe('搜索关键词'),
    count: z.number().int().min(1).max(30).optional().describe('返回结果条数，默认 5，最大 30'),
    page: z.number().int().min(1).max(10).optional().describe('页码，默认 1'),
    timeRange: z.enum(['all', 'day', 'week', 'month', 'year']).optional().describe('时间范围过滤'),
    resolveLinks: z.boolean().optional().describe('是否把搜狗跳转链接解析为真实 mp 链接，默认 true'),
    engine: z
      .enum(['auto', 'sogou', 'sogou-web', 'bing'])
      .optional()
      .describe('搜索源：auto=搜狗微信优先、网页搜索兜底（默认）；sogou=只用搜狗微信；sogou-web/bing=只用对应网页搜索（链接可直接访问，但没有公众号名与时间）'),
    withContent: z.number().int().min(0).max(5).optional().describe('顺带抓取前 N 篇正文，默认 0（不抓）'),
    maxChars: z.number().int().min(500).optional().describe('返回文本最大字符数，默认 60000'),
  },
  async (args) =>
    run(async () => {
      const res = await service.searchArticles({
        query: args.query,
        count: args.count,
        page: args.page,
        timeRange: args.timeRange,
        resolveLinks: args.resolveLinks,
        withContent: args.withContent,
        engine: args.engine,
      });
      return ok(res, args.maxChars ?? 60_000);
    }),
);

server.tool(
  'wechat_search_accounts',
  '按名称搜索微信公众号，返回公众号名、微信号、简介、认证信息。',
  {
    query: z.string().min(1).describe('公众号名称或关键词'),
    maxChars: z.number().int().min(500).optional(),
  },
  async (args) =>
    run(async () => ok(await service.searchAccounts(args.query), args.maxChars ?? 20_000)),
);

server.tool(
  'wechat_fetch_article',
  '读取一篇微信公众号文章的正文。支持 mp.weixin.qq.com 链接，也支持搜狗的 /link 跳转链接。返回 Markdown 正文。',
  {
    url: z.string().min(1).describe('文章链接：mp.weixin.qq.com 链接或搜狗 /link 链接'),
    format: z.enum(['markdown', 'text']).optional().describe('输出格式，默认 markdown'),
    downloadImages: z.boolean().optional().describe('是否把图片下载到本地并用本地路径替换（默认跟随配置）'),
    includeImages: z.boolean().optional().describe('是否返回图片链接清单，默认 true'),
    maxChars: z.number().int().min(500).optional().describe('正文最大字符数，默认 60000；超长会截断'),
    noCache: z.boolean().optional().describe('跳过缓存强制重新抓取'),
  },
  async (args) =>
    run(async () => {
      const art = await service.fetch(args.url, {
        format: args.format ?? 'markdown',
        downloadImages: args.downloadImages,
        noCache: args.noCache,
      });
      const body = args.format === 'text' ? art.text : art.markdown;
      const limit = args.maxChars ?? 60_000;
      const payload = {
        title: art.title,
        account: art.account,
        author: art.author,
        publishTime: art.publishTime,
        url: art.url,
        wordCount: art.wordCount,
        truncated: body.length > limit,
        content: body.slice(0, limit),
        ...(args.includeImages === false ? {} : { images: art.images.slice(0, 50) }),
      };
      return ok(payload, limit + 20_000);
    }),
);

server.tool(
  'wechat_fetch_batch',
  '批量读取多篇文章正文（串行执行以避免频控，最多 20 条）。失败的条目会单独给出错误原因，不影响其他条目。',
  {
    urls: z.array(z.string().min(1)).min(1).max(20).describe('文章链接数组'),
    format: z.enum(['markdown', 'text']).optional(),
    maxCharsPerArticle: z.number().int().min(500).optional().describe('单篇正文最大字符数，默认 20000'),
  },
  async (args) =>
    run(async () => {
      const res = await service.fetchBatch(args.urls, { format: args.format ?? 'markdown' });
      const limit = args.maxCharsPerArticle ?? 20_000;
      const slim = {
        requested: res.requested,
        ok: res.ok,
        failed: res.failed,
        items: res.items.map((it) => ({
          url: it.url,
          ok: it.ok,
          error: it.error,
          title: it.article?.title,
          account: it.article?.account,
          publishTime: it.article?.publishTime,
          wordCount: it.article?.wordCount,
          content: it.article
            ? (args.format === 'text' ? it.article.text : it.article.markdown).slice(0, limit)
            : undefined,
        })),
      };
      return ok(slim);
    }),
);

server.tool(
  'wechat_resolve_url',
  '把搜狗微信的 /link 跳转链接解析为可直接访问的 mp.weixin.qq.com 文章链接。',
  {
    url: z.string().min(1).describe('搜狗跳转链接或任意公众号文章链接'),
  },
  async (args) => run(async () => ok(await service.resolveUrl(args.url))),
);

server.tool(
  'wechat_list_account_articles',
  '列出某个公众号的文章。已配置公众号后台凭据时走后台接口拿历史文章分页；未配置时退化为"按公众号名搜索"，' +
    '只能拿到搜狗收录的部分文章（结果会带 notice 说明）。',
  {
    account: z.string().min(1).describe('公众号名称'),
    count: z.number().int().min(1).max(20).optional().describe('每页条数，默认 10，最多 20'),
    begin: z.number().int().min(0).optional().describe('后台列表偏移量，默认 0；使用返回的 nextBegin 翻页'),
    withContent: z.number().int().min(0).max(5).optional().describe('顺带抓取前 N 篇正文'),
    format: z.enum(['markdown', 'text']).optional(),
    maxChars: z.number().int().min(500).optional(),
  },
  async (args) =>
    run(async () =>
      ok(
        await service.listAccountArticles(args.account, {
          count: args.count,
          begin: args.begin,
          withContent: args.withContent,
          format: args.format,
        }),
        args.maxChars ?? 60_000,
      ),
    ),
);

server.tool(
  'wechat_status',
  '查看插件当前配置与可用能力（是否已配 cookie/代理/后台凭据等），用于排障。',
  {},
  async () => run(async () => ok(service.status())),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[wechat-mp] MCP server started (stdio)');
}

main().catch((err) => {
  console.error('[wechat-mp] fatal:', err);
  process.exit(1);
});


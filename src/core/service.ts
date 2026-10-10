import { safeUrl, isStopError } from './safety.js';
import { loadConfig, configSummary, type AppConfig } from './config.js';
import { HttpClient } from './http.js';
import { DiskCache } from './cache.js';
import { SogouClient, normalizeArticleUrl, type ArticleHit, type AccountHit, type TimeRange } from './sogou.js';
import { WebSearchClient, type WebEngine } from './websearch.js';import { ArticleClient, type Article, type FetchArticleOptions } from './article.js';
import { BackendClient } from './backend.js';
import { WechatError } from './errors.js';

export interface SearchArticlesInput {
  query: string;
  count?: number;
  page?: number;
  timeRange?: TimeRange;
  /** 是否把搜狗跳转链接解析为真实 mp 链接（默认 true） */
  resolveLinks?: boolean;
  /** 是否顺带抓取前 N 篇正文（默认 0，只返回摘要） */
  withContent?: number;
  format?: 'markdown' | 'text';
  /** 搜索源：auto=搜狗微信优先 + 网页搜索兜底；sogou=只用搜狗微信；sogou-web/bing=只用对应网页搜索 */
  engine?: 'auto' | 'sogou' | 'sogou-web' | 'bing';
}

export interface SearchResult {
  query: string;
  engine: string;
  count: number;
  hits: Array<
    ArticleHit & {
      article?: string;
      error?: string;
    }
  >;
  notice?: string;
}

function normalizeTitle(t: string): string {
  return t.replace(/[\s\-—_|｜·、，,。.！!？?：:；;"'“”‘’（）()【】\[\]]/g, '');
}

/** 兜底 + 合并：优先补齐缺链接的条目，再追加未重复的结果，最后让"有链接"的排前面 */
function mergeWithFallback(primary: ArticleHit[], fallback: ArticleHit[], count: number): ArticleHit[] {
  const used = new Set<number>();
  const merged = primary.map((hit) => ({ ...hit }));

  for (const hit of merged) {
    if (hit.url) continue;
    const key = normalizeTitle(hit.title);
    if (!key) continue;
    const idx = fallback.findIndex(
      (f, i) =>
        !used.has(i) &&
        f.url &&
        normalizeTitle(f.title) === key,
    );
    if (idx >= 0) {
      used.add(idx);
      hit.url = fallback[idx].url;
      hit.source = fallback[idx].source;
      hit.error = undefined;
    }
  }

  const have = new Set(merged.map((h) => h.url).filter(Boolean));
  for (const f of fallback) {
    if (used.has(fallback.indexOf(f)) || have.has(f.url)) continue;
    merged.push({ ...f });
    have.add(f.url);
  }
  // 有真实链接的排前面，保证返回给调用方的头部结果可读
  return merged
    .sort((a, b) => (a.url ? 0 : 1) - (b.url ? 0 : 1))
    .slice(0, Math.max(count, primary.length));
}

export interface BatchResult {
  requested: number;
  ok: number;
  failed: number;
  items: Array<{ url: string; ok: boolean; article?: Article; error?: { code: string; message: string } }>;
}

export class WechatMpService {
  readonly config: AppConfig;
  readonly http: HttpClient;
  readonly sogou: SogouClient;
  readonly web: WebSearchClient;
  readonly articles: ArticleClient;
  readonly backend: BackendClient;
  readonly cache: DiskCache;

  constructor(overrides: Partial<AppConfig> = {}) {
    this.config = loadConfig(overrides);
    this.http = new HttpClient(this.config);
    this.sogou = new SogouClient(this.http);
    this.web = new WebSearchClient(this.http);
    this.articles = new ArticleClient(this.http, this.config);
    this.backend = new BackendClient(this.http, this.config.backend?.cookie, this.config.backend?.token);
    this.cache = new DiskCache(this.config);
  }

  status() {
    return {
      ok: true,
      config: configSummary(this.config),
      capabilities: {
        searchArticles: true,
        fetchArticle: true,
        listAccountArticlesFull: this.backend.available,
        note: this.backend.available
          ? '公众号后台凭据已配置，可拉取历史文章分页'
          : '未配置公众号后台凭据，list_account_articles 将退化为"按公众号名搜索"（只能拿到搜狗收录的部分文章）',
      },
    };
  }

  clearCache(): number {
    return this.cache.clear();
  }

  async searchArticles(input: SearchArticlesInput): Promise<SearchResult> {
    const query = (input.query ?? '').trim();
    if (!query) throw new WechatError('BAD_URL', '缺少 query 参数');
    const count = Math.max(1, Math.min(input.count ?? 5, 30));
    const engine = input.engine ?? 'auto';

    let notices: string[] = [];
    let hits: ArticleHit[] = [];
    let usedEngine: string = engine;

    if (engine === 'sogou-web' || engine === 'bing') {
      const webEngine: WebEngine = engine;
      if ((input.page ?? 1) !== 1 || (input.timeRange ?? 'all') !== 'all') throw new WechatError('BAD_URL', '网页搜索不支持页码或时间范围，请使用 sogou');
      hits = await this.web.searchArticles(query, count, webEngine);
    } else {
      // 搜狗微信主通道：拿元数据（公众号名、时间）。风控时 auto 模式降级，不直接失败
      let sogouFailed: string | undefined;
      try {
        const cacheKey = DiskCache.key('search', query, input.page ?? 1, input.timeRange ?? 'all');
        let sogouHits = this.cache.get<ArticleHit[]>(cacheKey);
        if (!sogouHits) {
          sogouHits = await this.sogou.searchArticles(query, { page: input.page, timeRange: input.timeRange });
          this.cache.set(cacheKey, sogouHits);
        }
        sogouHits = sogouHits.map((h) => ({ ...h, source: 'sogou' as const }));

        let resolved = sogouHits;
        if (input.resolveLinks !== false) {
          resolved = await this.sogou.resolveAll(
            sogouHits,
            count,
            `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}`,
          );
          const updates = new Map(resolved.map(h => [h.sogouLink ?? h.url, h]));
          this.cache.set(cacheKey, sogouHits.map(h => updates.get(h.sogouLink ?? h.url) ?? h));
        }
        hits = resolved;
      } catch (err) {
        if (isStopError(err) || engine !== 'auto') throw err;
        sogouFailed = err instanceof WechatError ? `${err.code}: ${err.message}` : String(err);
        notices.push(`搜狗微信不可用（${sogouFailed}），已改用网页搜索。`);
        hits = [];
      }

      if (sogouFailed && ((input.page ?? 1) !== 1 || (input.timeRange ?? 'all') !== 'all')) throw new WechatError('PARSE_FAILED', sogouFailed);
      let missing = hits.filter((h) => !h.url).length;
      if (engine === 'auto' && (input.page ?? 1) === 1 && (input.timeRange ?? 'all') === 'all' && (missing > 0 || sogouFailed)) {
        for (const webEngine of ['sogou-web', 'bing'] as WebEngine[]) {
          try {
            // 兜底查询：先用完整关键词，命中不足时用首个词再试一次
            const variants = [query, ...(query.includes(' ') ? [query.split(/\s+/)[0]] : [])];
            let webHits: ArticleHit[] = [];
            for (const v of variants) {
              const r = await this.web.searchArticles(v, count, webEngine);
              webHits = webHits.concat(r);
              if (webHits.length >= count) break;
            }
            if (!webHits.length) continue;
            hits = hits.length ? mergeWithFallback(hits, webHits, count) : webHits;
            usedEngine = hits.length && !sogouFailed ? `sogou+${webEngine}` : webEngine;
            notices.push(`已用 ${webEngine} 兜底提供 ${webHits.length} 条可直接访问的结果。`);
            const still = hits.filter((h) => !h.url).length;
            if (still === 0) break;
            missing = still;
          } catch (err) {
            if (isStopError(err)) throw err;
            notices.push(`${webEngine} 兜底失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        notices.push('搜狗微信的 /link 跳转有频控，如需稳定走搜狗通道，请配置 WECHAT_MP_SOGOU_COOKIE 或降低请求频率。');
      }
    }

    const sliced = hits.slice(0, count);
    const out: SearchResult['hits'] = sliced.map((h) => ({ ...h }));

    const withContent = input.withContent ?? 0;
    if (withContent > 0) {
      for (let i = 0; i < Math.min(withContent, out.length); i++) {
        const hit = out[i];
        if (!hit.url) {
          hit.error = hit.error ?? '无可用链接';
          continue;
        }
        try {
          const art = await this.fetch(hit.url, { format: input.format ?? 'markdown' });
          hit.article = input.format === 'text' ? art.text : art.markdown;
        } catch (err) {
          if (isStopError(err)) throw err;
          hit.error = err instanceof WechatError ? `${err.code}: ${err.message}` : String(err);
        }
      }
    }

    const stillMissing = out.some((h) => !h.url);
    if (stillMissing) {
      notices.push('仍有条目未拿到真实链接，可直接让用户粘贴文章链接后用 fetch_article 读取。');
    }

    return {
      query,
      engine: usedEngine,
      count: out.length,
      hits: out,
      notice: notices.length ? notices.join(' ') : undefined,
    };
  }

  async searchAccounts(query: string): Promise<{ query: string; count: number; accounts: AccountHit[] }> {
    const q = (query ?? '').trim();
    if (!q) throw new WechatError('BAD_URL', '缺少 query 参数');
    const cacheKey = DiskCache.key('accounts', q);
    let accounts = this.cache.get<AccountHit[]>(cacheKey);
    if (!accounts) {
      accounts = await this.sogou.searchAccounts(q);
      this.cache.set(cacheKey, accounts);
    }
    return { query: q, count: accounts.length, accounts };
  }

  async fetch(url: string, opts: FetchArticleOptions = {}): Promise<Article> {
    const cacheKey = DiskCache.key('article-v011', url.trim(), opts.format ?? 'markdown', opts.downloadImages ?? (this.config.images.mode === 'local'), this.config.images.mode);
    if (!opts.noCache) {
      const cached = this.cache.get<Article>(cacheKey);
      if (cached) return cached;
    }
    const article = await this.articles.fetch(url, opts);
    if (!opts.noCache) this.cache.set(cacheKey, article);
    return article;
  }

  async fetchBatch(urls: string[], opts: FetchArticleOptions = {}): Promise<BatchResult> {
    const list = (urls ?? []).map((u) => String(u).trim()).filter(Boolean).slice(0, 20);
    const items: BatchResult['items'] = [];
    for (const u of list) {
      try {
        const art = await this.fetch(u, opts);
        items.push({ url: u, ok: true, article: art });
      } catch (err) {
        if (isStopError(err)) throw err;
        items.push({
          url: u,
          ok: false,
          error:
            err instanceof WechatError
              ? { code: err.code, message: err.message }
              : { code: 'NETWORK', message: String(err) },
        });
      }
    }
    return { requested: list.length, ok: items.filter((i) => i.ok).length, failed: items.filter((i) => !i.ok).length, items };
  }

  async resolveUrl(url: string): Promise<{ input: string; resolved: string; normalized: string }> {
    const input = String(url ?? '').trim();
    let resolved = input;
    if (safeUrl(input).hostname === 'weixin.sogou.com') {
      resolved = await this.sogou.resolveLink(input);
    }
    return { input, resolved, normalized: safeUrl(normalizeArticleUrl(resolved), 'article').href };
  }

  /**
   * 列出某公众号的文章。
   * - 已配置后台凭据：走公众号后台接口，可拿到历史文章分页（真实能力）
   * - 未配置：退化为"按公众号名搜索"，只能拿到搜狗收录的部分文章
   */
  async listAccountArticles(
    account: string,
    opts: { count?: number; begin?: number; withContent?: number; format?: 'markdown' | 'text' } = {},
  ): Promise<unknown> {
    const name = (account ?? '').trim();
    if (!name) throw new WechatError('BAD_URL', '缺少 account 参数');
    const count = Math.max(1, Math.min(opts.count ?? 10, 30));

    if (this.backend.available) {
      const accounts = await this.backend.searchAccount(name);
      if (!accounts.length) return { account: name, mode: 'backend', count: 0, items: [] };
      const target = accounts.find((a) => a.nickname === name || a.alias === name);
      if (!target) throw new WechatError('NOT_FOUND', '没有精确匹配的公众号，请使用完整名称或微信号');
      const begin = Math.max(0, Math.floor(opts.begin ?? 0));
      const { total, items } = await this.backend.listArticles(target.fakeid, begin, Math.min(count, 20));

      const out: any[] = [];
      for (const it of items.slice(0, count)) {
        const row: any = { ...it };
        if ((opts.withContent ?? 0) > 0 && out.length < (opts.withContent as number)) {
          try {
            const art = await this.fetch(it.link, { format: opts.format ?? 'markdown' });
            row.content = opts.format === 'text' ? art.text : art.markdown;
          } catch (err) {
            if (isStopError(err)) throw err;
            row.error = err instanceof WechatError ? `${err.code}: ${err.message}` : String(err);
          }
        }
        out.push(row);
      }
      return { account: name, mode: 'backend', fakeid: target.fakeid, total, begin, nextBegin: begin + items.length < total && items.length ? begin + items.length : null, count: out.length, items: out };
    }

    if (opts.begin) throw new WechatError('NOT_CONFIGURED', '后台翻页需要后台凭据');
    // 降级：搜狗搜索 + 公众号名过滤
    const res = await this.searchArticles({ query: name, count: 30, resolveLinks: true });
    const filtered = res.hits.filter((h) => h.account && (h.account === name || name.includes(h.account) || h.account.includes(name)));
    for (const hit of filtered.slice(0, Math.min(opts.withContent ?? 0, count))) {
      if (hit.url) { const art = await this.fetch(hit.url); hit.article = opts.format === 'text' ? art.text : art.markdown; }
    }
    return {
      account: name,
      mode: 'degraded',
      count: Math.min(filtered.length, count),
      items: filtered.slice(0, count),
      notice:
        '未配置公众号后台凭据，这里只能返回搜狗收录的部分文章（且与公众号名做了模糊匹配，可能不完整）。' +
        '如需历史文章分页：在 config.json 的 backend 中填入 token 与 cookie（浏览器登录 mp.weixin.qq.com 后复制）。',
    };
  }
}

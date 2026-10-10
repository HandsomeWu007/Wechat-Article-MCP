import { safeUrl, isStopError } from './safety.js';
import * as cheerio from 'cheerio';
import type { HttpClient } from './http.js';
import { WechatError } from './errors.js';

const SOGOU_HOME = 'https://weixin.sogou.com/';
const SOGOU_SEARCH = 'https://weixin.sogou.com/weixin';

export interface ArticleHit {
  title: string;
  /** 规范化后的 mp.weixin.qq.com 链接（长期可用） */
  url: string;
  /** 搜狗跳转链接（含时效参数，仅短期可用） */
  sogouLink?: string;
  account?: string;
  accountUrl?: string;
  snippet?: string;
  publishTime?: string;
  cover?: string;
  /** 来源引擎：sogou / bing */
  source?: 'sogou' | 'bing' | 'sogou-web';
  /** 该条目的处理异常（如链接解析失败） */
  error?: string;
}

export interface AccountHit {
  name: string;
  wechatId?: string;
  description?: string;
  verified?: string;
  avatar?: string;
  /** 搜狗上进一步检索该公众号的链接 */
  searchUrl?: string;
  recentArticle?: { title: string; url: string };
}

/** 时间范围：对应搜狗 tsn 参数 */
export type TimeRange = 'all' | 'day' | 'week' | 'month' | 'year';

const TSN: Record<TimeRange, string> = { all: '0', day: '1', week: '2', month: '3', year: '4' };

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 把搜狗跳转载出的链接规范化为可直接访问的 mp.weixin.qq.com 链接。
 * 微信的部分时效参数（k/h）过期后会导致 401，剔除后通常仍可访问。
 */
export function normalizeArticleUrl(raw: string): string {
  let url = decodeEntities(raw).trim();
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('http://')) url = url.replace(/^http:\/\//, 'https://');
  try {
    const u = new URL(url);
    if (u.hostname !== 'mp.weixin.qq.com') return url;
    for (const p of ['k', 'h', 'uin', 'key', 'poc_token']) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

function assertNotBlocked(text: string, finalUrl: string, searchPage = true) {
  const blocked =
    finalUrl.includes('antispider') ||
    text.includes('antispider') ||
    text.includes('请输入验证码') ||
    (text.includes('验证码') && text.includes('sogou'));
  if (blocked) throw new WechatError('SOGOU_BLOCKED', '搜狗微信返回了反爬验证页');
  // 参数不合法时搜狗会 302 回首页，此时页面里没有结果列表
  if (searchPage && !finalUrl.includes('/weixin?')) {
    throw new WechatError('PARSE_FAILED', `搜狗把请求重定向到了 ${finalUrl}（通常是参数不被接受或触发了风控）`);
  }
}

export class SogouClient {
  constructor(private readonly http: HttpClient) {}
  private bootstrappedAt = 0;
  private async check(text: string, url: string, searchPage = true) {
    try { assertNotBlocked(text, url, searchPage); } catch (e) {
      if (isStopError(e)) await this.http.gate.pause(url);
      throw e;
    }
  }

  /**
   * 建立搜狗会话 cookie。
   * 关键：SNUID 只在访问了 www.sogou.com 的搜索页后才会下发（domain=.sogou.com），
   * 拿到后共享给 weixin.sogou.com，能显著降低 /link 跳转与搜索出现验证码的概率。
   */
  async bootstrap(): Promise<void> {
    if (Date.now() - this.bootstrappedAt < 30 * 60000) return;
    try {
      const warm = await this.http.get(`https://www.sogou.com/web?query=${encodeURIComponent('微信公众号')}`, {
        cookieFrom: 'sogou',
        referer: 'https://www.sogou.com/',
      });
      await this.check(warm.text, warm.url, false);
    } catch (e) {
      if (isStopError(e)) throw e;
      /* 拿不到 SNUID 也要继续 */
    }
    try {
      const home = await this.http.get(SOGOU_HOME, { cookieFrom: 'sogou', referer: SOGOU_HOME });
      await this.check(home.text, home.url, false);
    } catch (e) {
      if (isStopError(e)) throw e;
    }
    this.bootstrappedAt = Date.now();
  }

  async searchArticles(query: string, opts: { page?: number; timeRange?: TimeRange } = {}): Promise<ArticleHit[]> {
    await this.bootstrap();
    const params = new URLSearchParams({
      type: '2',
      query,
      page: String(opts.page ?? 1),
      ie: 'utf8',
    });
    // 注意：tsn=0 会让搜狗重定向回首页，只在明确指定时间范围时才带上
    const tsn = TSN[opts.timeRange ?? 'all'];
    if (tsn !== '0') params.set('tsn', tsn);
    const url = `${SOGOU_SEARCH}?${params.toString()}`;
    const res = await this.http.get(url, { cookieFrom: 'sogou', referer: SOGOU_HOME });
    await this.check(res.text, res.url);

    const $ = cheerio.load(res.text);
    const hits: ArticleHit[] = [];

    $('ul.news-list > li').each((_, el) => {
      const li = $(el);
      const a = li.find('h3 a').first();
      const title = (a.attr('title') || a.text() || '').trim();
      const href = a.attr('href') ?? '';
      if (!title || !href) return;

      let sogouLink: string | undefined;
      let url2: string | undefined;
      if (href.startsWith('/link')) {
        sogouLink = new URL(href, SOGOU_HOME).toString();
        // 形如 /link?url=xxx，其中 url 参数常带有真实链接的一部分（有时可直接解码）
        const inner = new URL(sogouLink).searchParams.get('url') ?? '';
        if (inner.startsWith('http')) url2 = normalizeArticleUrl(inner);
      } else if (href.startsWith('http')) {
        url2 = normalizeArticleUrl(href);
      } else {
        sogouLink = new URL(href, SOGOU_HOME).toString();
      }

      const accountA = li.find('a.account').first();
      const script = li.find('span.s2 script, div.s-p script').text();
      const ts = script.match(/timeConvert\('(\d+)'\)/)?.[1];
      const cover = li.find('img').first().attr('src');

      hits.push({
        title: decodeEntities(title),
        url: url2 ?? '',
        sogouLink,
        account: decodeEntities(accountA.text().trim()) || undefined,
        accountUrl: accountA.attr('href') ? new URL(accountA.attr('href')!, SOGOU_HOME).toString() : undefined,
        snippet: decodeEntities(li.find('p.txt-info').text().replace(/\s+/g, ' ').trim()) || undefined,
        publishTime: ts ? new Date(Number(ts) * 1000).toISOString() : undefined,
        cover: cover ? (cover.startsWith('//') ? `https:${cover}` : cover) : undefined,
      });
    });

    if (hits.length === 0 && !res.text.includes('news-list')) {
      throw new WechatError('PARSE_FAILED', '未解析到搜索结果，搜狗页面结构可能已变化', {
        snippet: res.text.slice(0, 300),
      });
    }
    return hits;
  }

  async searchAccounts(query: string): Promise<AccountHit[]> {
    await this.bootstrap();
    const params = new URLSearchParams({ type: '1', query, ie: 'utf8' });
    const res = await this.http.get(`${SOGOU_SEARCH}?${params.toString()}`, {
      cookieFrom: 'sogou',
      referer: SOGOU_HOME,
    });
    await this.check(res.text, res.url);

    const $ = cheerio.load(res.text);
    const hits: AccountHit[] = [];

    $('ul.news-list2 > li').each((_, el) => {
      const li = $(el);
      const a = li.find('p.tit a, .txt-box .tit a').first();
      const name = decodeEntities((a.attr('title') || a.text() || '').trim());
      if (!name) return;

      const meta: Record<string, string> = {};
      li.find('dl').each((__, dl) => {
        const dts = $(dl).find('dt');
        const dds = $(dl).find('dd');
        dts.each((i, dt) => {
          const key = $(dt).text().replace(/[：:]\s*$/, '').trim();
          const val = $(dds[i]).text().trim();
          if (key) meta[key] = val;
        });
      });

      const avatar = li.find('img').first().attr('src');
      const recentA = li.find('a[href*="/link"], a[href*="mp.weixin"]').first();

      hits.push({
        name,
        wechatId: meta['微信号'] || undefined,
        description: decodeEntities(li.find('p.info').text().replace(/\s+/g, ' ').trim()) || undefined,
        verified: meta['认证'] || meta['微信认证'] || undefined,
        avatar: avatar ? (avatar.startsWith('//') ? `https:${avatar}` : avatar) : undefined,
        searchUrl: a.attr('href') ? new URL(a.attr('href')!, SOGOU_HOME).toString() : undefined,
        recentArticle:
          recentA.length && recentA.text().trim()
            ? { title: decodeEntities(recentA.text().trim()), url: recentA.attr('href') ?? '' }
            : undefined,
      });
    });

    return hits;
  }

  /**
   * 解析搜狗 /link 跳转页，得到真实文章链接。
   * 搜狗用 JS 拼接：url += '...'; var k = "..."; var h = "...";
   */
  async resolveLink(sogouLink: string, referer?: string): Promise<string> {
    safeUrl(sogouLink, 'sogou');
    const res = await this.http.get(sogouLink, {
      cookieFrom: 'sogou',
      referer: referer ?? `${SOGOU_SEARCH}?type=2`,
      headers: { Accept: '*/*' },
    });
    const text = res.text;
    await this.check(text, res.url, false);
    if (new URL(res.url).hostname === 'mp.weixin.qq.com') return safeUrl(normalizeArticleUrl(res.url), 'article').href;
    if (text.includes('该内容已被发布者删除')) throw new WechatError('ARTICLE_DELETED', '该文章已被发布者删除');

    const segments = [...text.matchAll(/url\s*\+=\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
    const k = text.match(/var\s+k\s*=\s*["']([^"']*)["']/)?.[1];
    const h = text.match(/var\s+h\s*=\s*["']([^"']*)["']/)?.[1];
    if (!segments.length) throw new WechatError('PARSE_FAILED', '无法从搜狗跳转页解析真实链接');

    let real = decodeEntities(segments.join(''));
    if (k) real += `&k=${k}`;
    if (h) real += `&h=${h}`;
    return safeUrl(normalizeArticleUrl(real), 'article').href;
  }

  /** 对搜索结果批量补齐真实链接（串行执行，避免触发搜狗频控） */
  async resolveAll(hits: ArticleHit[], limit: number, referer?: string): Promise<ArticleHit[]> {
    const out: ArticleHit[] = [];
    for (const hit of hits.slice(0, limit)) {
      if (!hit.url && hit.sogouLink) {
        try {
          hit.url = await this.resolveLink(hit.sogouLink, referer);
        } catch (err) {
          if (isStopError(err)) throw err;
          if (err instanceof WechatError && err.code === 'ARTICLE_DELETED') {
            hit.error = '文章已被删除';
            out.push(hit);
            continue;
          }
          hit.url = '';
          hit.error = err instanceof WechatError ? `${err.code}: ${err.message}` : String(err);
        }
      }
      out.push(hit);
    }
    return out;
  }
}

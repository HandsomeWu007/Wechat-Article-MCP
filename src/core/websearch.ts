import { safeUrl } from './safety.js';
import { WechatError } from './errors.js';
import * as cheerio from 'cheerio';
import type { HttpClient } from './http.js';
import type { ArticleHit } from './sogou.js';
import { normalizeArticleUrl } from './sogou.js';

export type WebEngine = 'sogou-web' | 'bing';

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 公开网页搜索兜底：拿"可直接访问"的 mp.weixin.qq.com 链接，绕过搜狗微信 /link 跳转的频控。
 * - sogou-web：搜狗网页搜索 site: 限定，国内可用，命中率高（默认）
 * - bing：Bing 搜索，作为再下一级兜底（site: 限定有时会被忽略，命中率较低）
 * 代价：拿不到公众号名与发布时间。
 */
export class WebSearchClient {
  constructor(private readonly http: HttpClient) {}

  async searchArticles(query: string, count = 10, engine: WebEngine = 'sogou-web'): Promise<ArticleHit[]> {
    return engine === 'bing' ? this.bing(query, count) : this.sogouWeb(query, count);
  }

  private async sogouWeb(query: string, count: number): Promise<ArticleHit[]> {
    const q = `site:mp.weixin.qq.com ${query}`;
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(q)}&page=1&ie=utf8`;
    const res = await this.http.get(url, {
      cookieFrom: 'none',
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    if (/antispider|请输入验证码/.test(res.text) || /antispider/.test(res.url)) {
      await this.http.gate.pause(url); throw new WechatError('SOGOU_BLOCKED', '搜索引擎要求验证，已停止');
    }
    const $ = cheerio.load(res.text);
    const hits: ArticleHit[] = [];

    $('div.vrwrap, div[class*="vrwrap"]').each((_, el) => {
      const box = $(el);
      const a = box.find('h3 a').first();
      const href = decodeEntities(a.attr('href') ?? '');
      const title = (a.text() || '').trim();
      try { safeUrl(normalizeArticleUrl(href), 'article'); } catch { return; }
      const snippet =
        box.find('.text-layout, .str-text-info, .fz-mid, p').first().text().replace(/\s+/g, ' ').trim() || undefined;
      hits.push({
        title: decodeEntities(title) || '(无标题)',
        url: normalizeArticleUrl(href),
        snippet,
        source: 'sogou-web',
      });
      if (hits.length >= count) return false;
    });

    return hits;
  }

  private async bing(query: string, count: number): Promise<ArticleHit[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(`site:mp.weixin.qq.com ${query}`)}&ensearch=0`;
    const res = await this.http.get(url, {
      cookieFrom: 'none',
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    if (/antispider|请输入验证码/.test(res.text) || /antispider/.test(res.url)) {
      await this.http.gate.pause(url); throw new WechatError('SOGOU_BLOCKED', '搜索引擎要求验证，已停止');
    }
    const $ = cheerio.load(res.text);
    const hits: ArticleHit[] = [];

    $('li.b_algo').each((_, el) => {
      const li = $(el);
      const a = li.find('h2 a').first();
      const href = a.attr('href') ?? '';
      const title = (a.text() || '').trim();
      try { safeUrl(normalizeArticleUrl(href), 'article'); } catch { return; }
      hits.push({
        title,
        url: normalizeArticleUrl(href),
        snippet: li.find('.b_caption p, p').first().text().replace(/\s+/g, ' ').trim() || undefined,
        source: 'bing' as const,
      });
      if (hits.length >= count) return false;
    });

    return hits;
  }
}

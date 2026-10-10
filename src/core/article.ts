import { safeUrl, isStopError } from './safety.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AppConfig } from './config.js';
import type { HttpClient } from './http.js';
import { WechatError } from './errors.js';
import { htmlToMarkdown, markdownToText } from './markdown.js';
import { normalizeArticleUrl } from './sogou.js';

export interface ArticleImage {
  url: string;
  localPath?: string;
  alt?: string;
}

export interface Article {
  /** 最终可用的文章链接 */
  url: string;
  /** 调用方传入的原始链接 */
  requestedUrl: string;
  title?: string;
  account?: string;
  author?: string;
  publishTime?: string;
  summary?: string;
  wordCount: number;
  markdown: string;
  text: string;
  images: ArticleImage[];
}

export interface FetchArticleOptions {
  format?: 'markdown' | 'text' | 'html';
  /** 是否把图片下载到本地（覆盖配置中的 images.mode） */
  downloadImages?: boolean;
  /** 是否跳过缓存 */
  noCache?: boolean;
}

const WX_REFERER = 'https://mp.weixin.qq.com/';

function detectGuard(text: string): void {
  const content = cheerio.load(text)('#js_content');
  if (content.length && (content.text().trim() || content.find('img,video,audio,iframe').length)) return;
  if (text.includes('该内容已被发布者删除') || text.includes('此内容发送失败无法查看')) {
    throw new WechatError('ARTICLE_DELETED', '该文章已被发布者删除或已撤回');
  }
  if (text.includes('此内容因违规无法查看') || text.includes('该账号已被屏蔽')) {
    throw new WechatError('ARTICLE_BLOCKED', '文章因违规或其他原因无法查看');
  }
  if (text.includes('参数错误') || text.includes('该链接已过期') || text.includes('链接已失效')) {
    throw new WechatError('BAD_URL', '链接参数无效或已过期（微信跳转链接通常有时效）');
  }
  if (
    text.includes('环境异常') ||
    text.includes('去验证') ||
    text.includes('请在微信客户端打开链接') ||
    text.includes('系统繁忙') ||
    res_guard(text)
  ) {
    throw new WechatError('WX_VERIFY_REQUIRED', '微信要求完成环境验证才能查看该文章');
  }
}

function res_guard(text: string): boolean {
  // 验证页通常没有正文容器，且带有 weixin110 相关提示
  return text.includes('weixin110') && !text.includes('js_content');
}

function pickText($: cheerio.CheerioAPI, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const t = $(sel).first().text().replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return undefined;
}

function parsePublishTime($: cheerio.CheerioAPI, html: string): string | undefined {
  const t = pickText($, ['#publish_time', '.rich_media_meta_text', 'em#publish_time']);
  if (t && /\d{4}-\d{2}-\d{2}/.test(t)) return t;
  const ct = html.match(/var\s+ct\s*=\s*"?(\d{10})"?/)?.[1] ?? html.match(/ct\s*=\s*"(\d{10})"/)?.[1];
  if (ct) return new Date(Number(ct) * 1000).toISOString();
  const meta = $('meta[property="article:published_time"]').attr('content');
  return meta && /\d{4}-\d{2}-\d{2}/.test(meta) ? meta : undefined;
}

function extFromContentType(ct: string | null): string {
  if (!ct) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  return 'jpg';
}

export class ArticleClient {
  constructor(
    private readonly http: HttpClient,
    private readonly config: AppConfig,
  ) {}

  private async downloadImage(url: string): Promise<string | undefined> {
    try {
      const res = await this.http.getBinary(url, {
        cookieFrom: 'none',
        referer: WX_REFERER,
        headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        retries: 1,
      });
      const ext = extFromContentType(res.headers.get('content-type'));
      const name = `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`;
      const dir = this.config.images.dir;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file, res.buffer);
      return file;
    } catch (e) {
      if (isStopError(e)) throw e;
      return undefined;
    }
  }

  /** 抓取并解析一篇公众号文章 */
  async fetch(rawUrl: string, opts: FetchArticleOptions = {}): Promise<Article> {
    const requestedUrl = rawUrl.trim();
    if (!requestedUrl) throw new WechatError('BAD_URL', '缺少 url 参数');

    let url = requestedUrl;
    if (safeUrl(url).hostname === 'weixin.sogou.com') {
      const { SogouClient } = await import('./sogou.js');
      url = await new SogouClient(this.http).resolveLink(url);
    } else {
      url = normalizeArticleUrl(url);
    }
    safeUrl(url, 'article');

    const attempts: Array<{ ua: string; label: string }> = [
      { ua: this.config.userAgent, label: 'desktop' },

    ];

    let res: Awaited<ReturnType<HttpClient['get']>> | undefined;
    let lastErr: unknown;
    for (const attempt of attempts) {
      try {
        res = await this.http.get(url, {
          cookieFrom: 'wxmp',
          userAgent: attempt.ua,
          referer: 'https://weixin.sogou.com/',
        });
        detectGuard(res.text);
        if (res.text.includes('js_content')) break;
        lastErr = new WechatError('PARSE_FAILED', `未找到正文容器（${attempt.label}）`);
      } catch (err) {
        lastErr = err;
        if (isStopError(err)) { await this.http.gate.pause(url); throw err; }
        if (err instanceof WechatError && ['ARTICLE_DELETED', 'ARTICLE_BLOCKED', 'BAD_URL'].includes(err.code)) throw err;
      }
    }
    if (!res) throw lastErr instanceof Error ? lastErr : new WechatError('NETWORK', '抓取失败');
    if (!res.text.includes('js_content')) {
      if (lastErr instanceof WechatError && lastErr.code !== 'PARSE_FAILED') throw lastErr;
      throw new WechatError(
        'PARSE_FAILED',
        '未能提取正文：微信未返回正文容器（常见原因：链接失效/过期、需要环境验证、或页面结构变化）',
        { snippet: res.text.replace(/\s+/g, ' ').slice(0, 300) },
      );
    }

    const html = res.text;
    const $ = cheerio.load(html);

    const title =
      pickText($, ['#activity-name', 'h1.rich_media_title', 'meta[property="og:title"]']) ??
      $('meta[property="og:title"]').attr('content')?.trim();
    const account = pickText($, ['#js_name', '.profile_nickname', 'a.account_nickname']);
    const author = pickText($, ['#js_author_name', '.rich_media_meta_text', 'meta[name="author"]']);
    const publishTime = parsePublishTime($, html);
    const summary = $('meta[name="description"]').attr('content')?.trim();

    const contentEl = $('#js_content').first();
    const contentHtml = contentEl.length ? (contentEl.html() ?? '') : ($('#img-content').html() ?? '');

    const download = opts.downloadImages ?? this.config.images.mode === 'local';
    const dropImages = this.config.images.mode === 'skip';
    const imageRecords: ArticleImage[] = [];

    const markdown = await htmlToMarkdown(contentHtml, {
      dropImages,
      rewriteImage: download
        ? (src) => {
            imageRecords.push({ url: src });
            return src; // 先占位，下载后统一替换
          }
        : undefined,
    });

    let finalMarkdown = markdown;
    if (download) {
      const map = new Map<string, string>();
      for (const rec of imageRecords) {
        const local = await this.downloadImage(rec.url);
        if (local) {
          rec.localPath = local;
          map.set(rec.url, local);
        }
      }
      finalMarkdown = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
        const local = map.get(src);
        return local ? `![${alt}](${local.replace(/\\/g, '/')})` : m;
      });
    } else {
      // 记录正文中出现的图片链接
      for (const m of markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        imageRecords.push({ url: m[2], alt: m[1] || undefined });
      }
    }

    const text = markdownToText(finalMarkdown);

    return {
      url,
      requestedUrl,
      title,
      account,
      author,
      publishTime,
      summary,
      wordCount: text.replace(/\s/g, '').length,
      markdown: finalMarkdown,
      text,
      images: imageRecords,
    };
  }
}

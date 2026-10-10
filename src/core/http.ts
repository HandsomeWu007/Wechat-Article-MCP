import { safeUrl, RequestGate } from './safety.js';
import iconv from 'iconv-lite';
import type { AppConfig } from './config.js';
import { WechatError } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** 覆盖默认 UA */
  userAgent?: string;
  referer?: string;
  /** 携带哪个站点的 cookie：'sogou' | 'wxmp' | 'none' */
  cookieFrom?: 'sogou' | 'wxmp' | 'none';
  timeoutMs?: number;
  retries?: number;
  /** 是否跟随重定向（默认 true） */
  followRedirects?: boolean;
  /** 直接写入 cookie jar 的域名，用于 next 请求自动携带 */
  jarHost?: string;
}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Headers;
  buffer: Buffer;
  text: string;
}

let proxyDispatcherPromise: Promise<unknown> | undefined;

async function ensureProxy(proxyUrl?: string): Promise<void> {
  if (!proxyUrl) return;
  if (!proxyDispatcherPromise) {
    proxyDispatcherPromise = (async () => {
      try {
        const undici: any = await import('undici');
        const agent = new undici.ProxyAgent({ uri: proxyUrl, requestTls: { timeout: 15_000 } });
        if (typeof undici.setGlobalDispatcher === 'function') undici.setGlobalDispatcher(agent);
        return agent;
      } catch {
        throw new WechatError(
          'NOT_CONFIGURED',
          '代理初始化失败，请检查代理配置与 Node 版本',
        );
      }
    })();
  }
  await proxyDispatcherPromise;
}

function decodeBuffer(buffer: Buffer, contentType: string | null): string {
  let charset = '';
  const ctMatch = contentType?.match(/charset=([\w-]+)/i);
  if (ctMatch) charset = ctMatch[1].toLowerCase();

  if (!charset) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    const metaMatch = head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i);
    if (metaMatch) charset = metaMatch[1].toLowerCase();
  }
  if (!charset) charset = 'utf-8';

  if (charset === 'utf-8' || charset === 'utf8') {
    // 容错：utf8 解码失败时回退 gbk（搜狗部分页面 GBK）
    const text = buffer.toString('utf8');
    return text.includes('\uFFFD'.repeat(2)) ? iconv.decode(buffer, 'gb18030') : text;
  }
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    return iconv.decode(buffer, 'gb18030');
  }
  try {
    return iconv.decode(buffer, charset);
  } catch {
    return buffer.toString('utf8');
  }
}

export class HttpClient {
  private jar = new Map<string, Map<string, string>>();
  readonly gate: RequestGate;
  readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.gate = new RequestGate(config);
  }

  private log(msg: string, ...rest: unknown[]) {
    if (this.config.debug) console.error(`[wechat-mp] ${msg}`, ...rest);
  }

  seedCookie(host: string, cookie?: string) {
    if (!cookie) return;
    const store = this.jar.get(host) ?? new Map<string, string>();
    for (const part of cookie.split(/[;,]\s*/)) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      store.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
    this.jar.set(host, store);
  }

  private absorbCookies(res: Response, host: string) {
    const raw: string[] =
      typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : [];
    if (!raw.length) return;
    const store = this.jar.get(host) ?? new Map<string, string>();
    for (const c of raw) {
      if (/max-age=0(?:;|$)/i.test(c)) { store.delete(c.split('=')[0]); continue; }
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    this.jar.set(host, store);
  }

  /**
   * 把某个 host 的 cookie 复制到另一个 host。
   * 用途：搜狗的 SNUID 由 www.sogou.com 下发但 domain 是 .sogou.com，
   * 手动共享给 weixin.sogou.com 后可显著降低验证码概率。
   */
  copyCookies(fromHost: string, toHost: string): void {
    const src = this.jar.get(fromHost);
    if (!src || src.size === 0) return;
    const dst = this.jar.get(toHost) ?? new Map<string, string>();
    for (const [k, v] of src) dst.set(k, v);
    this.jar.set(toHost, dst);
  }

  private cookieHeaderFor(url: string, from: RequestOptions['cookieFrom']): string | undefined {
    if (from === 'none' || !from) return undefined;
    const host = new URL(url).host;
    const store = this.jar.get(host);
    if (!store || store.size === 0) return undefined;
    return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    safeUrl(url);
    await ensureProxy(this.config.proxy);
    let current = url;
    const original = new URL(url);
    for (let hop = 0; hop <= 5; hop++) {
      const target = safeUrl(current);
      const from = opts.cookieFrom ?? 'none';
      const isSogou = ['weixin.sogou.com', 'www.sogou.com'].includes(target.hostname);
      const trustedCookie = from === 'wxmp' ? target.hostname === 'mp.weixin.qq.com' : from === 'sogou' && isSogou;
      if (trustedCookie && !this.jar.has(target.host)) this.seedCookie(target.host, from === 'wxmp' ? this.config.wxmpCookie : this.config.sogouCookie);
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? this.config.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.referer ? { Referer: opts.referer } : {}),
        ...(opts.headers ?? {}),
      };
      // Explicit backend credentials must never follow a cross-origin redirect.
      for (const k of Object.keys(headers)) {
        if (/^(cookie|authorization|referer)$/i.test(k) && target.origin !== original.origin) delete headers[k];
      }
      const cookie = trustedCookie ? this.cookieHeaderFor(current, from) : undefined;
      if (cookie) headers.Cookie = cookie;
      let redirected = false;
      const attempts = Math.max(0, Math.min(2, opts.retries ?? this.config.retries)) + 1;
      for (let i = 0; i < attempts; i++) {
        await this.gate.enter(current);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.config.timeoutMs);
        try {
          this.log(`${opts.method ?? 'GET'} ${target.origin}${target.pathname}`);
          const res = await fetch(current, { method: opts.method ?? 'GET', headers, body: opts.body, redirect: 'manual', signal: controller.signal });
          this.absorbCookies(res, target.host);
          if (res.status === 429 || res.status === 403) {
            await res.body?.cancel();
            const retry = res.headers.get('retry-after');
            const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
            await this.gate.pause(current, Math.max(this.config.cooldownMs ?? 900000, Number.isFinite(delay) ? delay : 0));
            throw new WechatError('RATE_LIMITED', `HTTP ${res.status}，已暂停该站点请求`);
          }
          if ([301, 302, 303, 307, 308].includes(res.status) && opts.followRedirects !== false) {
            const location = res.headers.get('location'); await res.body?.cancel();
            if (!location) throw new WechatError('HTTP_ERROR', '重定向缺少目标');
            const next = safeUrl(new URL(location, current).href);
            if (next.origin !== original.origin && !(original.hostname === 'weixin.sogou.com' && next.hostname === 'mp.weixin.qq.com')) {
              throw new WechatError('BAD_URL', '拒绝跨站重定向');
            }
            current = next.href; redirected = true; break;
          }
          if (res.status >= 400) {
            await res.body?.cancel();
            throw new WechatError('HTTP_ERROR', `HTTP ${res.status}`, { status: res.status });
          }
          const reader = res.body?.getReader();
          const chunks: Uint8Array[] = []; let size = 0;
          if (reader) while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new WechatError('HTTP_ERROR', '响应超过 20 MiB 限制'); }
            chunks.push(value);
          }
          const buffer = Buffer.concat(chunks);
          return { status: res.status, url: current, headers: res.headers, buffer, text: decodeBuffer(buffer, res.headers.get('content-type')) };
        } catch (err) {
          if (err instanceof WechatError) throw err;
          if (controller.signal.aborted) throw new WechatError('TIMEOUT', '请求或正文读取超时');
          if (i === attempts - 1) throw new WechatError('NETWORK', '网络请求失败');
        } finally { clearTimeout(timer); }
      }
      if (!redirected) break;
    }
    throw new WechatError('HTTP_ERROR', '重定向次数过多');
  }

  async get(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, { ...opts, method: 'GET' });
  }

  /** 下载二进制（图片等） */
  async getBinary(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, opts);
  }
}

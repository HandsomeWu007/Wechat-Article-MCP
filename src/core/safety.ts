import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { WechatError } from './errors.js';

export function safeUrl(raw: string, kind: 'article' | 'sogou' | 'request' = 'request'): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new WechatError('BAD_URL', '无效 URL'); }
  const hosts = kind === 'article' ? ['mp.weixin.qq.com'] : kind === 'sogou' ? ['weixin.sogou.com'] :
    ['mp.weixin.qq.com', 'weixin.sogou.com', 'www.sogou.com', 'www.bing.com', 'mmbiz.qpic.cn', 'mmbiz.qlogo.cn'];
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !hosts.includes(u.hostname)) {
    throw new WechatError('BAD_URL', 'URL 必须使用受信任站点的 HTTPS 地址');
  }
  if (kind === 'article' && u.pathname !== '/s' && !u.pathname.startsWith('/s/')) throw new WechatError('BAD_URL', '不是文章路径');
  if (kind === 'sogou' && u.pathname !== '/link') throw new WechatError('BAD_URL', '不是搜狗跳转链接');
  return u;
}
export function isStopError(e: unknown): boolean {
  return e instanceof WechatError && ['RATE_LIMITED', 'SOGOU_BLOCKED', 'WX_VERIFY_REQUIRED'].includes(e.code);
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export class RequestGate {
  private dir: string;
  constructor(private config: AppConfig) {
    this.dir = config.safetyDir ?? path.join(os.tmpdir(), `wechat-mp-safety-${process.getuid?.() ?? os.userInfo().username}`);
  }
  private group(url: string) {
    const host = new URL(url).hostname;
    return host.endsWith('.sogou.com') ? 'sogou' : host === 'www.bing.com' ? 'bing' : 'wechat';
  }
  private async update<T>(url: string, fn: (s: any) => T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, this.group(url) + '.json');
    const lock = file + '.lock';
    const deadline = Date.now() + 10000;
    let fd: number;
    while (true) {
      try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
      catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        // Only remove a lock whose recorded owner no longer exists. Never steal a live lock.
        try { const pid = Number(fs.readFileSync(lock, 'utf8')); if (pid > 0) {
          try { process.kill(pid, 0); } catch (err: any) { if (err.code === 'ESRCH') fs.unlinkSync(lock); }
        } } catch {}
        if (Date.now() > deadline) throw new WechatError('RATE_LIMITED', '请求队列忙，请稍后重试');
        await sleep(25);
      }
    }
    try {
      let state: any = {};
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new WechatError('RATE_LIMITED', '限流状态不可读，已停止请求'); }
      const value = fn(state);
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file);
      return value;
    } finally { fs.closeSync(fd!); fs.unlinkSync(lock); }
  }
  async pause(url: string, ms = this.config.cooldownMs ?? 900000) {
    await this.update(url, s => { s.until = Math.max(s.until ?? 0, Date.now() + ms); });
  }
  async enter(url: string) {
    const deadline = Date.now() + this.config.timeoutMs;
    while (true) {
      const wait = await this.update(url, s => {
        const now = Date.now();
        if (s.until > now) throw new WechatError('RATE_LIMITED', '站点正在冷却', { retryAt: new Date(s.until).toISOString() });
        s.times = (s.times ?? []).filter((t: number) => t > now - 3600000);
        if (s.times.length >= (this.config.maxRequestsPerHour ?? 120)) throw new WechatError('RATE_LIMITED', '已达到每小时请求预算');
        const wait = Math.max(0, (s.next ?? 0) - now);
        if (wait) return wait;
        s.next = now + Math.max(0, this.config.minIntervalMs); s.times.push(now);
        return 0;
      });
      if (!wait) return;
      if (Date.now() + wait > deadline) throw new WechatError('RATE_LIMITED', '请求队列已满，请稍后重试');
      await sleep(wait);
    }
  }
}

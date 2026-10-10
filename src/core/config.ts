import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录：src/core 或 dist/core 的上两级 */
export const PROJECT_ROOT = path.resolve(here, '..', ...(path.basename(here) === 'bin' ? [] : ['..']));

export type ImageMode = 'url' | 'local' | 'skip';

export interface AppConfig {
  /** 桌面 UA：用于搜狗搜索与文章页抓取 */
  userAgent: string;
  /** 移动端微信 UA：个别文章桌面 UA 受限时降级使用 */
  mobileUserAgent: string;
  /** 搜狗微信 cookie（SNUID/SUID/SUV...），用于缓解频控与验证码 */
  sogouCookie?: string;
  /** mp.weixin.qq.com cookie（浏览器登录后复制），用于按域名发送的可选凭据，不保证免验证 */
  wxmpCookie?: string;
  /** HTTP 代理，如 http://127.0.0.1:7890 */
  proxy?: string;
  timeoutMs: number;
  retries: number;
  /** 两次请求之间的最小间隔，防频控 */
  minIntervalMs: number;
  cache: { enabled: boolean; dir: string; ttlMinutes: number };
  images: { mode: ImageMode; dir: string };
  /** 预留：公众号后台凭据（token + cookie），配置后可用后台接口拉取任意公众号历史文章 */
  backend?: { token?: string; cookie?: string; fakeid?: string };
  /** 预留：第三方聚合 API */
  thirdParty?: { apiBase?: string; apiKey?: string };
  debug: boolean;
  safetyDir?: string;
  cooldownMs?: number;
  maxRequestsPerHour?: number;
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN';

export const DEFAULT_CONFIG: AppConfig = {
  userAgent: DESKTOP_UA,
  mobileUserAgent: MOBILE_UA,
  timeoutMs: 20_000,
  retries: 0,
  minIntervalMs: 3000,
  cache: {
    enabled: true,
    dir: path.join(os.tmpdir(), 'wechat-mp-cache'),
    ttlMinutes: 60 * 24,
  },
  images: { mode: 'url', dir: path.join(PROJECT_ROOT, 'images') },
  debug: false,
};

function readJsonIfExists(file: string): Record<string, any> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function configSearchPaths(): string[] {
  const paths: string[] = [];
  if (process.env.WECHAT_MP_CONFIG) paths.push(process.env.WECHAT_MP_CONFIG);
  paths.push(path.join(PROJECT_ROOT, 'config.json'));
  paths.push(path.join(os.homedir(), '.wechat-mp', 'config.json'));
  return paths;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return fallback;
}

/**
 * 配置优先级：环境变量 > config.json（项目根 / ~/.wechat-mp）> 默认值
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  let file: Record<string, any> = {};
  for (const p of configSearchPaths()) {
    const found = readJsonIfExists(p);
    if (found) {
      file = found;
      break;
    }
  }
  const env = process.env;

  const cfg: AppConfig = {
    userAgent: env.WECHAT_MP_UA ?? file.userAgent ?? DEFAULT_CONFIG.userAgent,
    mobileUserAgent: file.mobileUserAgent ?? DEFAULT_CONFIG.mobileUserAgent,
    sogouCookie: env.WECHAT_MP_SOGOU_COOKIE ?? file.sogouCookie ?? undefined,
    wxmpCookie: env.WECHAT_MP_WXMP_COOKIE ?? file.wxmpCookie ?? undefined,
    proxy: env.WECHAT_MP_PROXY ?? file.proxy ?? undefined,
    timeoutMs: Math.max(1000, num(env.WECHAT_MP_TIMEOUT_MS ?? file.timeoutMs, DEFAULT_CONFIG.timeoutMs)),
    retries: Math.max(0, Math.min(2, Math.floor(num(file.retries, DEFAULT_CONFIG.retries)))),
    minIntervalMs: Math.max(1000, num(file.minIntervalMs, DEFAULT_CONFIG.minIntervalMs)),
    cache: {
      enabled: bool(env.WECHAT_MP_CACHE ?? file.cache?.enabled, DEFAULT_CONFIG.cache.enabled),
      dir: env.WECHAT_MP_CACHE_DIR || file.cache?.dir || DEFAULT_CONFIG.cache.dir,
      ttlMinutes: num(file.cache?.ttlMinutes, DEFAULT_CONFIG.cache.ttlMinutes),
    },
    images: {
      mode: (env.WECHAT_MP_IMAGE_MODE ?? file.images?.mode ?? DEFAULT_CONFIG.images.mode) as ImageMode,
      dir: env.WECHAT_MP_IMAGE_DIR || file.images?.dir || DEFAULT_CONFIG.images.dir,
    },
    safetyDir: file.safetyDir,
    cooldownMs: Math.max(60000, num(file.cooldownMs, 15 * 60000)),
    maxRequestsPerHour: Math.max(1, Math.floor(num(file.maxRequestsPerHour, 120))),
    debug: bool(env.WECHAT_MP_DEBUG ?? file.debug, DEFAULT_CONFIG.debug),
  };

  const backend = {
    token: env.WECHAT_MP_BACKEND_TOKEN ?? file.backend?.token,
    cookie: env.WECHAT_MP_BACKEND_COOKIE ?? file.backend?.cookie,
    fakeid: file.backend?.fakeid,
  };
  if (backend.token || backend.cookie) cfg.backend = backend;

  const thirdParty = {
    apiBase: env.WECHAT_MP_API_BASE ?? file.thirdParty?.apiBase,
    apiKey: env.WECHAT_MP_API_KEY ?? file.thirdParty?.apiKey,
  };
  if (thirdParty.apiBase || thirdParty.apiKey) cfg.thirdParty = thirdParty;

  return { ...cfg, ...overrides };
}

/** 脱敏后的配置快照，用于 status 输出 / 排障 */
export function configSummary(cfg: AppConfig): Record<string, unknown> {
  const mask = (v?: string) => v ? '[configured]' : undefined;
  return {
    userAgent: cfg.userAgent.slice(0, 40) + '…',
    sogouCookie: mask(cfg.sogouCookie),
    wxmpCookie: mask(cfg.wxmpCookie),
    proxy: cfg.proxy ? '[configured]' : null,
    timeoutMs: cfg.timeoutMs,
    minIntervalMs: cfg.minIntervalMs,
    cache: cfg.cache,
    images: cfg.images,
    backendConfigured: Boolean(cfg.backend?.token || cfg.backend?.cookie),
    thirdPartyConfigured: Boolean(cfg.thirdParty?.apiBase || cfg.thirdParty?.apiKey),
    debug: cfg.debug,
  };
}

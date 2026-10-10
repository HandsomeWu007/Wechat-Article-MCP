import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from './config.js';

interface CacheEntry<T> {
  at: number;
  value: T;
}

/** 极简磁盘缓存：避免重复抓取触发平台频控 */
export class DiskCache {
  readonly dir: string;
  private readonly ttlMs: number;
  readonly enabled: boolean;

  constructor(config: AppConfig) {
    this.enabled = config.cache.enabled;
    this.dir = config.cache.dir;
    this.ttlMs = Math.max(0, config.cache.ttlMinutes) * 60_000;
  }

  static key(...parts: (string | number | boolean | undefined)[]): string {
    return crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex');
  }

  private fileFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  get<T>(key: string): T | undefined {
    if (!this.enabled) return undefined;
    try {
      const file = this.fileFor(key);
      if (!fs.existsSync(file)) return undefined;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntry<T>;
      if (Date.now() - raw.at > this.ttlMs) {
        fs.unlinkSync(file);
        return undefined;
      }
      return raw.value;
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.fileFor(key), JSON.stringify({ at: Date.now(), value }));
    } catch {
      /* 缓存失败不影响主流程 */
    }
  }

  clear(): number {
    let n = 0;
    try {
      if (!fs.existsSync(this.dir)) return 0;
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.json')) {
          fs.unlinkSync(path.join(this.dir, f));
          n++;
        }
      }
    } catch {
      /* ignore */
    }
    return n;
  }
}

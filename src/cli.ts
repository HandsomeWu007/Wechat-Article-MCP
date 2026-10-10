#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { WechatMpService } from './core/service.js';
import { WechatError } from './core/errors.js';

const HELP = `
wechat-mp — 微信公众号文章访问 CLI（与 MCP server 共用同一套内核）

用法:
  wechat-mp search "关键词" [--count 10] [--content 0] [--time week] [--engine auto|sogou|bing] [--json]
  wechat-mp accounts "公众号名"
  wechat-mp fetch <url> [--format md|text] [--images] [--out 文件] [--json]
  wechat-mp batch <url...> [--format md|text] [--json]
  wechat-mp resolve <url>
  wechat-mp account "公众号名" [--count 10] [--json]
  wechat-mp status
  wechat-mp cache-clear

选项:
  --json       以 JSON 输出（便于 agent 解析）
  --count N    结果条数（搜索默认 5，最大 30）
  --content N  搜索后顺带抓取前 N 篇正文
  --format     输出格式：md（默认）| text
  --images     把图片下载到本地并用本地路径替换
  --out FILE   把结果写入文件而不是 stdout
  --no-cache   跳过缓存
  --debug      输出调试日志到 stderr

环境变量:
  WECHAT_MP_SOGOU_COOKIE   搜狗微信 cookie（缓解验证码）
  WECHAT_MP_WXMP_COOKIE    mp.weixin.qq.com cookie（按域名发送的可选凭据，不保证免验证）
  WECHAT_MP_PROXY          HTTP 代理，如 http://127.0.0.1:7890
  WECHAT_MP_BACKEND_TOKEN  公众号后台 token（历史文章列表能力）
  WECHAT_MP_BACKEND_COOKIE 公众号后台 cookie
  WECHAT_MP_CONFIG         指定 config.json 路径
`.trim();

type Flags = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { flags._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['json', 'debug', 'images', 'no-cache'].includes(key)) { flags[key] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else if (key === 'out') {
        flags.out = next;
        i++;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

const num = (v: unknown, d: number) => (typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : d);

function emit(payload: string, flags: Flags) {
  const out = typeof flags.out === 'string' ? flags.out : undefined;
  if (out) {
    fs.mkdirSync(path.dirname(out) || '.', { recursive: true });
    fs.writeFileSync(out, payload, 'utf8');
    console.error(`已写入 ${out}`);
  } else {
    process.stdout.write(payload + '\n');
  }
}

function fail(err: unknown): never {
  if (err instanceof WechatError) {
    console.error(`✗ ${err.code}: ${err.message}`);
    if (err.hint) console.error(`→ ${err.hint}`);
  } else {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const [cmd, ...rest] = flags._ as string[];
  const asJson = Boolean(flags.json);

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(HELP);
    return;
  }

  const svc = new WechatMpService({ ...(flags.debug ? { debug: true } : {}) });

  switch (cmd) {
    case 'status': {
      emit(JSON.stringify(svc.status(), null, 2), { _: [], json: true });
      return;
    }
    case 'cache-clear': {
      const n = svc.clearCache();
      console.log(`已清理 ${n} 条缓存`);
      return;
    }
    case 'search': {
      const query = rest.join(' ');
      if (!query) return fail(new WechatError('BAD_URL', '缺少搜索关键词'));
      const res = await svc.searchArticles({
        query,
        count: num(flags.count, 5),
        timeRange: (typeof flags.time === 'string' ? flags.time : 'all') as any,
        withContent: num(flags.content, 0),
        engine: (typeof flags.engine === 'string' ? flags.engine : 'auto') as any,
      });
      if (asJson) return emit(JSON.stringify(res, null, 2), flags);
      const lines = res.hits.map((h, i) => {
        const head = `${i + 1}. ${h.title}`;
        const meta = [h.account, h.publishTime?.slice(0, 10)].filter(Boolean).join(' · ');
        const url = h.url || (h.sogouLink ? `(需解析) ${h.sogouLink}` : '(无链接)');
        return [head, meta && `   ${meta}`, `   ${url}`, h.snippet ? `   ${h.snippet.slice(0, 120)}` : '']
          .filter(Boolean)
          .join('\n');
      });
      emit(lines.join('\n\n') + (res.notice ? `\n\n注：${res.notice}` : ''), flags);
      return;
    }
    case 'accounts': {
      const res = await svc.searchAccounts(rest.join(' '));
      if (asJson) return emit(JSON.stringify(res, null, 2), flags);
      emit(
        res.accounts
          .map((a) => `${a.name}${a.wechatId ? ` (${a.wechatId})` : ''}\n   ${a.description ?? ''}`)
          .join('\n\n'),
        flags,
      );
      return;
    }
    case 'fetch': {
      const url = rest[0];
      if (!url) return fail(new WechatError('BAD_URL', '缺少 url'));
      const art = await svc.fetch(url, {
        format: flags.format === 'text' ? 'text' : 'markdown',
        downloadImages: flags.images ? true : undefined,
        noCache: Boolean(flags['no-cache']),
      });
      if (asJson) return emit(JSON.stringify(art, null, 2), flags);
      const body = flags.format === 'text' ? art.text : art.markdown;
      const header = `# ${art.title ?? '(无标题)'}\n\n- 公众号：${art.account ?? '-'}\n- 时间：${art.publishTime ?? '-'}\n- 链接：${art.url}\n- 字数：${art.wordCount}\n\n---\n\n`;
      emit(header + body, flags);
      return;
    }
    case 'batch': {
      const res = await svc.fetchBatch(rest, { format: flags.format === 'text' ? 'text' : 'markdown' });
      if (asJson) return emit(JSON.stringify(res, null, 2), flags);
      emit(
        res.items
          .map((it) => (it.ok ? `# ${it.article?.title}\n${it.url}\n\n${(flags.format === 'text' ? it.article?.text : it.article?.markdown) ?? ''}` : `# ✗ ${it.url}\n${it.error?.code}: ${it.error?.message}`))
          .join('\n\n---\n\n'),
        flags,
      );
      return;
    }
    case 'resolve': {
      const r = await svc.resolveUrl(rest[0] ?? '');
      emit(asJson ? JSON.stringify(r, null, 2) : r.normalized, flags);
      return;
    }
    case 'account': {
      const res = await svc.listAccountArticles(rest.join(' '), { count: num(flags.count, 10), begin: num(flags.begin, 0) });
      emit(JSON.stringify(res, null, 2), { _: [], json: true });
      return;
    }
    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch(fail);
